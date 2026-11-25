/**
 * The ShipWarden push relay. It sends a short notification to the iPhone app through the Apple Push Notification
 * service (APNs). The relay keeps no data: no database, no files, and no message text. Only the rate limits are in
 * memory.
 *
 * The flow:
 * 1. The phone sends its APNs device token to `POST /v1/register`. The relay encrypts the token into a ticket with its
 *    secret and returns the ticket and a push key. The push key is an HMAC of the ticket, so only the relay can make it.
 * 2. The phone gives the ticket and the push key to its paired Mac, over the pinned HTTPS connection.
 * 3. The Mac sends `POST /v1/push` with the ticket, the kind of the notification, and a worktree name. It signs the
 *    time and the body with the push key. The relay checks the signature, opens the ticket, makes the notification
 *    text itself, and sends it to APNs.
 *
 * Thus a Mac can push only to the phones that gave it a ticket, and the Mac never sees a device token.
 * This file uses only Web Crypto, so it runs in Node and in other JavaScript runtimes.
 */

export const RELAY_VERSION = 1;

/** The kinds of notifications. The relay makes the title of each kind. The Mac cannot send its own text. */
export const PUSH_KINDS = ['needsInput', 'approval', 'test'] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

export const PUSH_TITLES: Record<PushKind, string> = {
    needsInput: 'Agent needs input',
    approval: 'Automation is waiting for approval',
    test: 'Notifications work'
};

/** The body of `POST /v1/push`. */
export interface PushRequest {
    ticket: string;
    kind: PushKind;
    /** The name of the worktree. The notification shows it. */
    worktree?: string;
    /** The agent session that needs input. A tap opens it. */
    agentId?: string;
    /** The automation run that is waiting for approval. */
    runId?: string;
}

/** The body of `POST /v1/register`. */
export interface RegisterRequest {
    /** The APNs device token, as hex. */
    deviceToken: string;
    /** "sandbox" for a development build of the app, "production" for TestFlight and the App Store. */
    environment: 'sandbox' | 'production';
}

/** The answer to `POST /v1/register`. */
export interface RegisterResponse {
    ticket: string;
    /** The key that signs the push requests of this ticket, as base64url. */
    key: string;
}

/** The headers of a signed push request. */
export const TIME_HEADER = 'x-shipwarden-time';
export const SIGNATURE_HEADER = 'x-shipwarden-signature';

/** The relay accepts a signed request only when its time is at most this far from the time of the relay. */
export const MAX_CLOCK_SKEW_SECONDS = 300;

export interface RelayConfig {
    /** A random secret of at least 32 characters. It encrypts the tickets. A new secret makes all tickets invalid. */
    secret: string;
    /** The Team ID of the Apple developer account. */
    teamId: string;
    /** The ID of the APNs key (.p8). */
    keyId: string;
    /** The content of the .p8 file (PEM, PKCS #8). */
    privateKey: string;
    /** The bundle ID of the iPhone app, for example "dev.shipwarden.ios". */
    topic: string;
}

/** A request to APNs. The transport sends it over HTTP/2. */
export interface ApnsRequest {
    host: 'api.push.apple.com' | 'api.sandbox.push.apple.com';
    deviceToken: string;
    headers: Record<string, string>;
    body: string;
}

export interface ApnsResponse {
    status: number;
    /** The "reason" of the APNs error body, for example "BadDeviceToken". */
    reason?: string;
}

export type ApnsSend = (request: ApnsRequest) => Promise<ApnsResponse>;

export interface RelayRequest {
    method: string;
    path: string;
    /** The header names in lowercase. */
    headers: Record<string, string | undefined>;
    body: string;
    /** The address of the client, for the rate limit of the registrations. */
    ip?: string;
}

export interface RelayResponse {
    status: number;
    body: Record<string, unknown>;
}

export interface RelayOptions {
    now?: () => number;
    /** The most pushes for one ticket in one hour. */
    pushesPerHour?: number;
    /** The most registrations from one address in one hour. */
    registrationsPerHour?: number;
}

const MAX_BODY_LENGTH = 4096;
const MAX_WORKTREE_LENGTH = 100;
const ID_PATTERN = /^[\w.-]{1,100}$/;
/** An APNs device token is 32 bytes today. Apple can make it longer, so the relay accepts up to 100 bytes. */
const TOKEN_PATTERN = /^[0-9a-f]{64,200}$/;
/** APNs accepts a provider token for 60 minutes. The relay makes a new one after 40 minutes. */
const JWT_LIFETIME_MS = 40 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const TICKET_PREFIX = 'v1.';
/** Bytes in a normal ArrayBuffer. Web Crypto accepts only these. */
type Bytes = Uint8Array<ArrayBuffer>;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** An error with an HTTP status for the client. */
export class RelayError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

// ---- Encoding ----

export function base64url(bytes: Bytes): string {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Bytes {
    if (!/^[\w-]*$/.test(text)) throw new RelayError(400, 'The value is not base64url.');
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, char => char.charCodeAt(0));
}

/** Removes control characters and extra spaces, and shortens the text. */
export function cleanText(value: string, max: number): string {
    const clean = value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

// ---- Keys ----

interface Keys {
    ticket: CryptoKey;
    iv: CryptoKey;
    push: CryptoKey;
}

async function deriveKeys(secret: string): Promise<Keys> {
    const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
    const derive = (info: string, algorithm: AesKeyGenParams | HmacKeyGenParams, usages: KeyUsage[]) =>
        crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(info) }, base, algorithm, false, usages);
    return {
        ticket: await derive('shipwarden-relay ticket', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
        iv: await derive('shipwarden-relay ticket-iv', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
        push: await derive('shipwarden-relay push-key', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign'])
    };
}

async function hmac(key: CryptoKey, data: Bytes | string): Promise<Bytes> {
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, typeof data === 'string' ? encoder.encode(data) : data));
}

/** Compares two byte arrays in a time that does not depend on the first difference. */
export function sameBytes(a: Bytes, b: Bytes): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let index = 0; index < a.length; index++) diff |= a[index] ^ b[index];
    return diff === 0;
}

// ---- Tickets ----

const TICKET_AAD = encoder.encode('shipwarden-ticket-v1');

/**
 * Encrypts a registration into a ticket. The IV is an HMAC of the content, so the same registration always gives the
 * same ticket. The Mac and the phone then see no change when the phone registers again.
 */
async function sealTicket(keys: Keys, registration: RegisterRequest): Promise<string> {
    const plain = encoder.encode(JSON.stringify({ t: registration.deviceToken, e: registration.environment }));
    const iv = (await hmac(keys.iv, plain)).slice(0, 12);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: TICKET_AAD }, keys.ticket, plain));
    const bytes = new Uint8Array(iv.length + sealed.length);
    bytes.set(iv);
    bytes.set(sealed, iv.length);
    return TICKET_PREFIX + base64url(bytes);
}

async function openTicket(keys: Keys, ticket: string): Promise<RegisterRequest> {
    if (!ticket.startsWith(TICKET_PREFIX)) throw new RelayError(400, 'The ticket is not valid.');
    const bytes = fromBase64url(ticket.slice(TICKET_PREFIX.length));
    if (bytes.length < 12 + 16) throw new RelayError(400, 'The ticket is not valid.');
    let plain: ArrayBuffer;
    try {
        plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: TICKET_AAD }, keys.ticket, bytes.slice(12));
    } catch {
        throw new RelayError(403, 'The ticket is not valid. Open the iPhone app to register again.');
    }
    const value = JSON.parse(decoder.decode(plain)) as { t: string; e: RegisterRequest['environment'] };
    return { deviceToken: value.t, environment: value.e };
}

/** The push key of a ticket. Only the relay can make it, because it needs the secret. */
async function pushKeyOf(keys: Keys, ticket: string): Promise<Bytes> {
    return hmac(keys.push, ticket);
}

/** Signs a push request: an HMAC-SHA256 of "<time>.<body>" with the push key. Returns the signature as base64url. */
export async function signPush(key: Bytes, time: number, body: string): Promise<string> {
    const hmacKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return base64url(await hmac(hmacKey, `${time}.${body}`));
}

// ---- APNs ----

function pemBody(pem: string): Bytes {
    const text = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
    return Uint8Array.from(atob(text), char => char.charCodeAt(0));
}

/** Makes the provider token (a JWT with ES256) for APNs. */
export async function apnsJwt(config: Pick<RelayConfig, 'teamId' | 'keyId' | 'privateKey'>, now: number): Promise<string> {
    const key = await crypto.subtle.importKey('pkcs8', pemBody(config.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const header = base64url(encoder.encode(JSON.stringify({ alg: 'ES256', kid: config.keyId })));
    const claims = base64url(encoder.encode(JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) })));
    // Web Crypto gives the raw r || s signature, which is the JWT format.
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(`${header}.${claims}`)));
    return `${header}.${claims}.${base64url(signature)}`;
}

/** The APNs payload of a push. The relay makes all the text. Only the worktree name comes from the Mac. */
export function apnsPayload(push: PushRequest): Record<string, unknown> {
    const alert: Record<string, string> = { title: PUSH_TITLES[push.kind] };
    if (push.kind === 'test') alert.body = 'ShipWarden can send notifications to this phone.';
    else if (push.worktree) alert.body = push.worktree;
    return {
        aps: { alert, sound: 'default', ...(push.worktree ? { 'thread-id': push.worktree } : {}) },
        kind: push.kind,
        ...(push.agentId ? { agentId: push.agentId } : {}),
        ...(push.runId ? { runId: push.runId } : {})
    };
}

/** The APNs errors that tell that the device token does not work anymore. The Mac then forgets the ticket. */
const GONE_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

// ---- Validation ----

function parseJson(body: string): Record<string, unknown> {
    if (body.length > MAX_BODY_LENGTH) throw new RelayError(413, 'The request is too large.');
    try {
        const value = JSON.parse(body) as unknown;
        if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
        // The error below tells it.
    }
    throw new RelayError(400, 'The request is not a JSON object.');
}

export function parseRegister(body: string): RegisterRequest {
    const value = parseJson(body);
    const deviceToken = typeof value.deviceToken === 'string' ? value.deviceToken.toLowerCase() : '';
    if (!TOKEN_PATTERN.test(deviceToken)) throw new RelayError(400, 'The device token is not valid.');
    if (value.environment !== 'sandbox' && value.environment !== 'production') {
        throw new RelayError(400, 'The environment must be "sandbox" or "production".');
    }
    return { deviceToken, environment: value.environment };
}

export function parsePush(body: string): PushRequest {
    const value = parseJson(body);
    if (typeof value.ticket !== 'string' || !value.ticket) throw new RelayError(400, 'The request has no ticket.');
    if (!(PUSH_KINDS as readonly unknown[]).includes(value.kind)) throw new RelayError(400, 'The kind of the notification is not known.');
    const id = (key: 'agentId' | 'runId'): string | undefined => {
        const item = value[key];
        if (item === undefined || item === null) return undefined;
        if (typeof item !== 'string' || !ID_PATTERN.test(item)) throw new RelayError(400, `The value "${key}" is not valid.`);
        return item;
    };
    const worktree = typeof value.worktree === 'string' ? cleanText(value.worktree, MAX_WORKTREE_LENGTH) : '';
    const agentId = id('agentId');
    const runId = id('runId');
    return {
        ticket: value.ticket,
        kind: value.kind as PushKind,
        ...(worktree ? { worktree } : {}),
        ...(agentId ? { agentId } : {}),
        ...(runId ? { runId } : {})
    };
}

// ---- Rate limits ----

/** Counts the requests of each key in a fixed window. It keeps the counts only in memory. */
export class RateLimiter {
    private readonly counts = new Map<string, { start: number; count: number }>();
    private readonly limit: number;
    private readonly windowMs: number;
    private readonly now: () => number;

    constructor(limit: number, windowMs: number, now: () => number) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.now = now;
    }

    /** Counts a request. Returns false when the key has no requests left in this window. */
    take(key: string): boolean {
        const now = this.now();
        if (this.counts.size > 10_000) this.prune(now);
        const entry = this.counts.get(key);
        if (!entry || now - entry.start >= this.windowMs) {
            this.counts.set(key, { start: now, count: 1 });
            return true;
        }
        if (entry.count >= this.limit) return false;
        entry.count += 1;
        return true;
    }

    private prune(now: number): void {
        for (const [key, entry] of this.counts) {
            if (now - entry.start >= this.windowMs) this.counts.delete(key);
        }
    }
}

// ---- The relay ----

export interface Relay {
    handle(request: RelayRequest): Promise<RelayResponse>;
}

/** Checks the configuration. Throws an error that names the missing value. */
export function checkConfig(config: Partial<RelayConfig>): RelayConfig {
    const missing = (['secret', 'teamId', 'keyId', 'privateKey', 'topic'] as const).filter(key => !config[key]);
    if (missing.length > 0) throw new Error(`The relay configuration has no value for: ${missing.join(', ')}.`);
    if ((config.secret ?? '').length < 32) throw new Error('The relay secret must have at least 32 characters.');
    return config as RelayConfig;
}

export function createRelay(config: RelayConfig, send: ApnsSend, options: RelayOptions = {}): Relay {
    const now = options.now ?? Date.now;
    const keys = deriveKeys(config.secret);
    const pushLimit = new RateLimiter(options.pushesPerHour ?? 120, HOUR_MS, now);
    const registerLimit = new RateLimiter(options.registrationsPerHour ?? 30, HOUR_MS, now);
    let jwt: { token: string; at: number } | undefined;

    async function providerToken(): Promise<string> {
        const at = now();
        if (!jwt || at - jwt.at > JWT_LIFETIME_MS) jwt = { token: await apnsJwt(config, at), at };
        return jwt.token;
    }

    async function register(request: RelayRequest): Promise<RelayResponse> {
        if (!registerLimit.take(request.ip ?? 'unknown')) throw new RelayError(429, 'Too many registrations. Try again later.');
        const registration = parseRegister(request.body);
        const ticket = await sealTicket(await keys, registration);
        const key = await pushKeyOf(await keys, ticket);
        return { status: 200, body: { ticket, key: base64url(key) } satisfies RegisterResponse };
    }

    async function push(request: RelayRequest): Promise<RelayResponse> {
        const time = Number(request.headers[TIME_HEADER]);
        const signature = request.headers[SIGNATURE_HEADER] ?? '';
        if (!Number.isInteger(time) || !signature) throw new RelayError(401, 'The request is not signed.');
        if (Math.abs(Math.floor(now() / 1000) - time) > MAX_CLOCK_SKEW_SECONDS) {
            throw new RelayError(401, 'The time of the request is not correct. Check the clock of the Mac.');
        }
        const body = parseJson(request.body);
        if (typeof body.ticket !== 'string' || !body.ticket) throw new RelayError(400, 'The request has no ticket.');
        const expected = await signPush(await pushKeyOf(await keys, body.ticket), time, request.body);
        if (!sameBytes(encoder.encode(expected), encoder.encode(signature))) throw new RelayError(401, 'The signature is not valid.');
        const message = parsePush(request.body);
        if (!pushLimit.take(message.ticket)) throw new RelayError(429, 'Too many notifications for this phone. Try again later.');
        const registration = await openTicket(await keys, message.ticket);
        const collapse = message.agentId ?? message.runId;
        const response = await send({
            host: registration.environment === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com',
            deviceToken: registration.deviceToken,
            headers: {
                authorization: `bearer ${await providerToken()}`,
                'apns-topic': config.topic,
                'apns-push-type': 'alert',
                'apns-priority': '10',
                'apns-expiration': String(Math.floor(now() / 1000) + 3600),
                ...(collapse ? { 'apns-collapse-id': `${message.kind}-${collapse}`.slice(0, 64) } : {})
            },
            body: JSON.stringify(apnsPayload(message))
        });
        if (response.status === 200) return { status: 200, body: {} };
        if (response.status === 410 || (response.reason && GONE_REASONS.has(response.reason))) {
            return {
                status: 410,
                body: { error: 'The phone does not accept notifications from this app anymore.', reason: response.reason ?? 'Unregistered' }
            };
        }
        if (response.status === 403) jwt = undefined;
        if (response.status === 429) throw new RelayError(429, 'Apple limits the notifications to this phone now. Try again later.');
        throw new RelayError(502, `Apple did not accept the notification (${response.status}${response.reason ? ` ${response.reason}` : ''}).`);
    }

    return {
        async handle(request) {
            try {
                if (request.method === 'GET' && request.path === '/health') return { status: 200, body: { ok: true, version: RELAY_VERSION } };
                if (request.method === 'POST' && request.path === '/v1/register') return await register(request);
                if (request.method === 'POST' && request.path === '/v1/push') return await push(request);
                return { status: 404, body: { error: 'This address does not exist.' } };
            } catch (error) {
                if (error instanceof RelayError) return { status: error.status, body: { error: error.message } };
                return { status: 500, body: { error: 'The relay failed.' } };
            }
        }
    };
}
