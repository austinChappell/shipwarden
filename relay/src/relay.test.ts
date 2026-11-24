import { describe, expect, it } from 'vitest';
import { sendPush, signPushRequest } from '../../src/main/push/relay-client.ts';
import {
    apnsJwt,
    apnsPayload,
    base64url,
    checkConfig,
    createRelay,
    fromBase64url,
    parsePush,
    RateLimiter,
    signPush,
    type ApnsRequest,
    type ApnsResponse,
    type RelayConfig,
    type RelayRequest
} from './relay.ts';

const TOKEN = 'a'.repeat(64);
const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);

async function makeKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const body = Buffer.from(der).toString('base64');
    return { pem: `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}

async function setup(options: { apns?: ApnsResponse; pushesPerHour?: number; secret?: string } = {}) {
    const { pem, publicKey } = await makeKey();
    const config: RelayConfig = {
        secret: options.secret ?? 's'.repeat(40),
        teamId: 'TEAM123456',
        keyId: 'KEY1234567',
        privateKey: pem,
        topic: 'dev.shipwarden.ios'
    };
    const sent: ApnsRequest[] = [];
    let now = NOW;
    const relay = createRelay(
        config,
        async request => {
            sent.push(request);
            return options.apns ?? { status: 200 };
        },
        { now: () => now, pushesPerHour: options.pushesPerHour }
    );
    const call = (request: Partial<RelayRequest>) => relay.handle({ method: 'POST', path: '/v1/push', headers: {}, body: '', ...request });
    const register = async (environment = 'sandbox', token = TOKEN) => {
        const result = await call({ path: '/v1/register', body: JSON.stringify({ deviceToken: token, environment }) });
        expect(result.status).toBe(200);
        return result.body as { ticket: string; key: string };
    };
    /** Sends a signed push, as the Mac does. */
    const push = async (ticket: { ticket: string; key: string }, message: Record<string, unknown>, time = Math.floor(now / 1000)) => {
        const body = JSON.stringify({ ticket: ticket.ticket, ...message });
        return call({ body, headers: { 'x-shipwarden-time': String(time), 'x-shipwarden-signature': signPushRequest(ticket.key, time, body) } });
    };
    return { relay, call, register, push, sent, publicKey, setNow: (value: number) => (now = value) };
}

describe('the push relay', () => {
    it('gives a ticket that hides the device token, and the same ticket for the same registration', async () => {
        const { register } = await setup();
        const first = await register();
        expect(first.ticket.startsWith('v1.')).toBe(true);
        expect(first.ticket).not.toContain(TOKEN);
        expect(await register()).toEqual(first);
        expect((await register('production')).ticket).not.toBe(first.ticket);
    });

    it('sends a signed push to APNs with the text of the relay and no other text', async () => {
        const { register, push, sent } = await setup();
        const ticket = await register();
        const result = await push(ticket, { kind: 'needsInput', worktree: 'fix-login', agentId: 'session-1' });
        expect(result).toEqual({ status: 200, body: {} });
        expect(sent).toHaveLength(1);
        expect(sent[0].host).toBe('api.sandbox.push.apple.com');
        expect(sent[0].deviceToken).toBe(TOKEN);
        expect(sent[0].headers['apns-topic']).toBe('dev.shipwarden.ios');
        expect(sent[0].headers['apns-push-type']).toBe('alert');
        expect(sent[0].headers['apns-collapse-id']).toBe('needsInput-session-1');
        expect(JSON.parse(sent[0].body)).toEqual({
            aps: { alert: { title: 'Agent needs input', body: 'fix-login' }, sound: 'default', 'thread-id': 'fix-login' },
            kind: 'needsInput',
            agentId: 'session-1'
        });
    });

    it('uses the production host for a production ticket', async () => {
        const { register, push, sent } = await setup();
        await push(await register('production'), { kind: 'test' });
        expect(sent[0].host).toBe('api.push.apple.com');
    });

    it('works with the client of the Mac', async () => {
        const { relay, register, sent } = await setup();
        const ticket = await register();
        const fakeFetch = (async (url: string, init: RequestInit) => {
            expect(url).toBe('https://relay.example.com/v1/push');
            const headers = init.headers as Record<string, string>;
            const result = await relay.handle({ method: 'POST', path: '/v1/push', headers, body: String(init.body) });
            return new Response(JSON.stringify(result.body), { status: result.status });
        }) as unknown as typeof fetch;
        const result = await sendPush(
            'https://relay.example.com/',
            ticket,
            { kind: 'approval', worktree: 'api', runId: 'run-1' },
            { fetch: fakeFetch, now: () => NOW }
        );
        expect(result).toEqual({ ok: true });
        expect(JSON.parse(sent[0].body).aps.alert.title).toBe('Automation is waiting for approval');
    });

    it('signs the same way as the Mac', async () => {
        const key = base64url(new Uint8Array(32).fill(7));
        expect(await signPush(fromBase64url(key), 1700000000, '{"a":1}')).toBe(signPushRequest(key, 1700000000, '{"a":1}'));
    });

    it('refuses a push without a valid signature', async () => {
        const { register, push, call, sent } = await setup();
        const ticket = await register();
        const other = await register('sandbox', 'b'.repeat(64));
        // The key of a different ticket.
        expect((await push({ ticket: ticket.ticket, key: other.key }, { kind: 'test' })).status).toBe(401);
        // No signature.
        expect(
            (await call({ body: JSON.stringify({ ticket: ticket.ticket, kind: 'test' }), headers: { 'x-shipwarden-time': String(NOW / 1000) } })).status
        ).toBe(401);
        expect(sent).toHaveLength(0);
    });

    it('refuses a changed body', async () => {
        const { register, call } = await setup();
        const ticket = await register();
        const time = NOW / 1000;
        const body = JSON.stringify({ ticket: ticket.ticket, kind: 'test' });
        const signature = signPushRequest(ticket.key, time, body);
        const changed = body.replace('test', 'needsInput');
        expect((await call({ body: changed, headers: { 'x-shipwarden-time': String(time), 'x-shipwarden-signature': signature } })).status).toBe(401);
    });

    it('refuses an old request', async () => {
        const { register, push } = await setup();
        const ticket = await register();
        expect((await push(ticket, { kind: 'test' }, NOW / 1000 - 600)).status).toBe(401);
    });

    it('refuses a ticket of a relay with a different secret', async () => {
        const first = await setup({ secret: 'x'.repeat(40) });
        const ticket = await first.register();
        const second = await setup({ secret: 'y'.repeat(40) });
        expect((await second.push(ticket, { kind: 'test' })).status).toBe(401);
    });

    it('limits the pushes of one ticket', async () => {
        const { register, push, setNow } = await setup({ pushesPerHour: 2 });
        const ticket = await register();
        expect((await push(ticket, { kind: 'test' })).status).toBe(200);
        expect((await push(ticket, { kind: 'test' })).status).toBe(200);
        expect((await push(ticket, { kind: 'test' })).status).toBe(429);
        setNow(NOW + 61 * 60 * 1000);
        expect((await push(ticket, { kind: 'test' })).status).toBe(200);
    });

    it('answers 410 when APNs does not know the device anymore', async () => {
        const gone = await setup({ apns: { status: 410, reason: 'Unregistered' } });
        expect((await gone.push(await gone.register(), { kind: 'test' })).status).toBe(410);
        const bad = await setup({ apns: { status: 400, reason: 'BadDeviceToken' } });
        expect((await bad.push(await bad.register(), { kind: 'test' })).status).toBe(410);
        const other = await setup({ apns: { status: 500, reason: 'InternalServerError' } });
        expect((await other.push(await other.register(), { kind: 'test' })).status).toBe(502);
    });

    it('refuses a registration with a bad token or environment', async () => {
        const { call } = await setup();
        expect((await call({ path: '/v1/register', body: JSON.stringify({ deviceToken: 'xyz', environment: 'sandbox' }) })).status).toBe(400);
        expect((await call({ path: '/v1/register', body: JSON.stringify({ deviceToken: TOKEN, environment: 'beta' }) })).status).toBe(400);
        expect((await call({ path: '/v1/register', body: 'not json' })).status).toBe(400);
    });

    it('answers the health check and 404 for other paths', async () => {
        const { call } = await setup();
        expect((await call({ method: 'GET', path: '/health' })).status).toBe(200);
        expect((await call({ method: 'GET', path: '/v1/push' })).status).toBe(404);
    });
});

describe('the push request', () => {
    it('cleans the worktree name and checks the IDs', () => {
        expect(parsePush(JSON.stringify({ ticket: 't', kind: 'needsInput', worktree: '  fix\n\tlogin ', agentId: 'abc-1' }))).toEqual({
            ticket: 't',
            kind: 'needsInput',
            worktree: 'fix login',
            agentId: 'abc-1'
        });
        expect(parsePush(JSON.stringify({ ticket: 't', kind: 'test', worktree: 'x'.repeat(300) })).worktree).toHaveLength(100);
        expect(() => parsePush(JSON.stringify({ ticket: 't', kind: 'spam' }))).toThrow('not known');
        expect(() => parsePush(JSON.stringify({ ticket: 't', kind: 'test', agentId: '../etc' }))).toThrow('agentId');
    });

    it('has no body for an approval without a worktree', () => {
        expect(apnsPayload({ ticket: 't', kind: 'approval', runId: 'r1' })).toEqual({
            aps: { alert: { title: 'Automation is waiting for approval' }, sound: 'default' },
            kind: 'approval',
            runId: 'r1'
        });
    });
});

describe('the APNs provider token', () => {
    it('is an ES256 JWT that the public key verifies', async () => {
        const { pem, publicKey } = await makeKey();
        const token = await apnsJwt({ teamId: 'TEAM', keyId: 'KID', privateKey: pem }, NOW);
        const [header, claims, signature] = token.split('.');
        expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KID' });
        expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({ iss: 'TEAM', iat: NOW / 1000 });
        const valid = await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            publicKey,
            fromBase64url(signature),
            new TextEncoder().encode(`${header}.${claims}`)
        );
        expect(valid).toBe(true);
    });
});

describe('the configuration', () => {
    it('names the missing values and needs a long secret', () => {
        expect(() => checkConfig({ secret: 's'.repeat(40) })).toThrow('teamId, keyId, privateKey, topic');
        expect(() => checkConfig({ secret: 'short', teamId: 'a', keyId: 'b', privateKey: 'c', topic: 'd' })).toThrow('32 characters');
    });
});

describe('the rate limiter', () => {
    it('counts each key in its own window', () => {
        let now = 0;
        const limiter = new RateLimiter(1, 1000, () => now);
        expect(limiter.take('a')).toBe(true);
        expect(limiter.take('a')).toBe(false);
        expect(limiter.take('b')).toBe(true);
        now = 1000;
        expect(limiter.take('a')).toBe(true);
    });
});
