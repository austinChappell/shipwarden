import { createServer, type Server } from 'https';
import type { IncomingMessage, ServerResponse } from 'http';
import { networkInterfaces } from 'os';
import {
    inputWrites,
    pairingLink,
    REMOTE_PROTOCOL,
    type PairingOffer,
    type RemoteAgent,
    type RemoteDevice,
    type RemoteInput,
    type RemoteSettings,
    type RemoteSnapshot,
    type RemoteStatus
} from '@shared/remote';
import type { TerminalReplay, TerminalSession } from '@shared/terminal';
import type { RemoteDevices } from './remote-devices';
import { agentOf } from './remote-snapshot';
import { ScreenMirror } from './screen-mirror';
import type { TlsIdentity } from './tls-identity';

/** The parts of ShipWarden that the phone API uses. */
export interface RemoteBackend {
    /** The name of the Mac, for example "Austin's MacBook Pro". */
    macName(): string;
    version: string;
    /** The projects, repositories, worktrees and agents. */
    snapshot(): Promise<Omit<RemoteSnapshot, 'protocol' | 'mac'>>;
    sessions(): Promise<TerminalSession[]>;
    replay(id: string): Promise<TerminalReplay>;
    write(id: string, data: string): void;
    approvePullRequest(worktreePath: string, number: number, headSha: string, body: string): Promise<void>;
    /** Tells the settings page that the devices or the connections changed. */
    onStatusChanged(): void;
}

export interface RemoteServerOptions {
    devices: RemoteDevices;
    backend: RemoteBackend;
    identity(): Promise<TlsIdentity>;
    /** The addresses of the Mac. Tests replace it. */
    hosts?(): string[];
    /** The interface to listen on. The default is all interfaces. */
    listenHost?: string;
}

const MAX_BODY_BYTES = 64 * 1024;
const KEEPALIVE_MS = 15_000;
/** Screen updates go out at most at this interval. */
const SCREEN_INTERVAL_MS = 150;
/** A mirror without viewers stays for this time, so the phone can open the agent again fast. */
const MIRROR_IDLE_MS = 30_000;
/** The time between the text and Enter. Claude Code takes text and Enter in one chunk as a paste. */
const SUBMIT_DELAY_MS = 120;
const DEFAULT_SIZE = { cols: 120, rows: 36 };

class HttpError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

/**
 * Returns the addresses of this Mac for the phone: the Bonjour name first, then the IPv4 addresses of the network
 * interfaces. `localHostName` is the Bonjour name without ".local" (`scutil --get LocalHostName`). The host name of
 * the system is not the Bonjour name. A DHCP server can set it, for example to "mac.lan".
 */
export function localHosts(localHostName?: string): string[] {
    const hosts = localHostName ? [`${localHostName}.local`] : [];
    for (const list of Object.values(networkInterfaces())) {
        for (const item of list ?? []) {
            if (item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.')) hosts.push(item.address);
        }
    }
    return [...new Set(hosts)];
}

interface Stream {
    response: ServerResponse;
    deviceId: string;
}

interface MirrorEntry {
    mirror: ScreenMirror;
    viewers: Set<Stream>;
    /** Live output that came while the replay loads. */
    queue: { data: string; seq: number }[] | undefined;
    timer?: NodeJS.Timeout;
    idleTimer?: NodeJS.Timeout;
    lastSentAt: number;
    lastJson?: string;
}

/**
 * The HTTPS server for the phone app. It listens only while the setting is on. Each request except the pairing
 * needs the token of a paired phone.
 */
export class RemoteServer {
    private server: Server | undefined;
    private settings: RemoteSettings | undefined;
    private error: string | undefined;
    private fingerprint: string | undefined;
    private readonly eventStreams = new Set<Stream>();
    private readonly mirrors = new Map<string, MirrorEntry>();
    private keepalive: NodeJS.Timeout | undefined;
    private agentsTimer: NodeJS.Timeout | undefined;

    constructor(private readonly options: RemoteServerOptions) {}

    /** Applies the settings: starts, restarts or stops the server. */
    async apply(settings: RemoteSettings): Promise<void> {
        const same = this.settings?.enabled === settings.enabled && this.settings?.port === settings.port;
        this.settings = settings;
        if (same && (this.server || !settings.enabled)) return;
        await this.stop();
        if (settings.enabled) {
            await this.start(settings.port);
        }
        this.options.backend.onStatusChanged();
    }

    /** The port that the server listens on. Tests use port 0 and read the real port here. */
    get port(): number | undefined {
        const address = this.server?.address();
        return address && typeof address === 'object' ? address.port : undefined;
    }

    async status(): Promise<RemoteStatus> {
        const connected = [...new Set([...this.eventStreams].map(stream => stream.deviceId))];
        return {
            enabled: this.settings?.enabled ?? false,
            running: !!this.server?.listening,
            port: this.port ?? this.settings?.port ?? 0,
            error: this.error,
            fingerprint: this.fingerprint,
            hosts: this.hosts(),
            devices: await this.options.devices.list(),
            connected
        };
    }

    /** Makes a pairing link for a QR code. The server must run. */
    startPairing(): PairingOffer {
        if (!this.server?.listening || !this.fingerprint) {
            throw new Error('Turn on phone connections first.');
        }
        const { code, expiresAt } = this.options.devices.startPairing();
        const link = pairingLink({
            name: this.options.backend.macName(),
            hosts: this.hosts(),
            port: this.port ?? 0,
            fingerprint: this.fingerprint,
            code
        });
        return { link, expiresAt };
    }

    cancelPairing(): void {
        this.options.devices.cancelPairing();
    }

    /** Removes a phone and closes its connections. */
    async removeDevice(id: string): Promise<void> {
        await this.options.devices.remove(id);
        for (const stream of [...this.eventStreams]) {
            if (stream.deviceId === id) stream.response.end();
        }
        for (const entry of this.mirrors.values()) {
            for (const stream of [...entry.viewers]) {
                if (stream.deviceId === id) stream.response.end();
            }
        }
        this.options.backend.onStatusChanged();
    }

    /** Tells the phones that the agents changed. The update waits a moment, so several changes make one update. */
    agentsChanged(): void {
        if (this.eventStreams.size === 0 || this.agentsTimer) return;
        this.agentsTimer = setTimeout(() => {
            this.agentsTimer = undefined;
            void this.sendAgents();
        }, 200);
    }

    /** Output of a terminal. Only a terminal that a phone shows has a mirror. */
    terminalData(id: string, data: string, seq: number): void {
        const entry = this.mirrors.get(id);
        if (!entry) return;
        if (entry.queue) {
            entry.queue.push({ data, seq });
            return;
        }
        void entry.mirror.write(data, seq).then(() => this.scheduleScreen(id));
    }

    terminalResized(id: string, cols: number, rows: number): void {
        const entry = this.mirrors.get(id);
        if (entry) {
            entry.mirror.resize(cols, rows);
            this.scheduleScreen(id);
        }
    }

    terminalExited(id: string): void {
        const entry = this.mirrors.get(id);
        if (entry) {
            for (const stream of entry.viewers) this.sendEvent(stream.response, 'exit', {});
        }
        this.agentsChanged();
    }

    async stop(): Promise<void> {
        clearInterval(this.keepalive);
        this.keepalive = undefined;
        clearTimeout(this.agentsTimer);
        this.agentsTimer = undefined;
        for (const stream of this.eventStreams) stream.response.end();
        this.eventStreams.clear();
        for (const [id, entry] of this.mirrors) {
            entry.viewers.forEach(stream => stream.response.end());
            this.disposeMirror(id);
        }
        this.options.devices.cancelPairing();
        const server = this.server;
        this.server = undefined;
        if (server) {
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    }

    private hosts(): string[] {
        return this.options.hosts ? this.options.hosts() : localHosts();
    }

    private async start(port: number): Promise<void> {
        this.error = undefined;
        let identity: TlsIdentity;
        try {
            identity = await this.options.identity();
        } catch (error) {
            this.error = `ShipWarden cannot make its certificate: ${error instanceof Error ? error.message : String(error)}`;
            return;
        }
        this.fingerprint = identity.fingerprint;
        const server = createServer({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.2' }, (request, response) => {
            void this.handle(request, response);
        });
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, this.options.listenHost, () => {
                    server.off('error', reject);
                    resolve();
                });
            });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            this.error = code === 'EADDRINUSE'
                ? `Port ${port} is in use by another app. Select a different port.`
                : `ShipWarden cannot listen on port ${port}: ${error instanceof Error ? error.message : String(error)}`;
            server.close();
            return;
        }
        server.on('error', error => console.error('[remote] Server error:', error));
        this.server = server;
        this.keepalive = setInterval(() => {
            for (const stream of this.eventStreams) stream.response.write(': keepalive\n\n');
            for (const entry of this.mirrors.values()) entry.viewers.forEach(stream => stream.response.write(': keepalive\n\n'));
        }, KEEPALIVE_MS);
    }

    private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        try {
            const url = new URL(request.url ?? '/', 'https://localhost');
            const path = url.pathname;
            if (request.method === 'POST' && path === '/v1/pair') {
                return await this.pair(request, response);
            }
            const device = await this.options.devices.authenticate(bearerToken(request));
            if (!device) {
                throw new HttpError(401, 'This phone is not paired. Pair it again in ShipWarden › Settings › Mobile.');
            }
            if (request.method === 'GET' && path === '/v1/state') {
                return sendJson(response, 200, await this.snapshot());
            }
            if (request.method === 'GET' && path === '/v1/events') {
                return await this.openEvents(device, response);
            }
            const screen = /^\/v1\/sessions\/([\w-]+)\/screen$/.exec(path);
            if (request.method === 'GET' && screen) {
                return await this.openScreen(device, screen[1], response);
            }
            const input = /^\/v1\/sessions\/([\w-]+)\/input$/.exec(path);
            if (request.method === 'POST' && input) {
                await this.input(input[1], await readJson(request) as RemoteInput);
                return sendJson(response, 200, {});
            }
            if (request.method === 'POST' && path === '/v1/pull-requests/approve') {
                const body = await readJson(request) as Record<string, unknown>;
                if (typeof body.worktreePath !== 'string' || typeof body.number !== 'number' || typeof body.headSha !== 'string') {
                    throw new HttpError(400, 'The request needs a worktree, a pull request number and a head commit.');
                }
                await this.options.backend.approvePullRequest(body.worktreePath, body.number, body.headSha, typeof body.body === 'string' ? body.body : '');
                return sendJson(response, 200, {});
            }
            throw new HttpError(404, 'This address does not exist.');
        } catch (error) {
            if (response.headersSent) {
                response.end();
                return;
            }
            const status = error instanceof HttpError ? error.status : 500;
            const message = error instanceof Error ? error.message : String(error);
            if (status === 500) console.error('[remote] Request failed:', error);
            sendJson(response, status, { error: message });
        }
    }

    private async pair(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const body = await readJson(request) as Record<string, unknown>;
        const result = await this.options.devices.pair(body.code, body.name);
        if (!result) {
            throw new HttpError(403, 'The pairing code is not valid. It is possibly old or used. Show a new code in ShipWarden › Settings › Mobile.');
        }
        this.options.backend.onStatusChanged();
        sendJson(response, 200, {
            protocol: REMOTE_PROTOCOL,
            token: result.token,
            deviceId: result.device.id,
            mac: { name: this.options.backend.macName(), version: this.options.backend.version }
        });
    }

    private async snapshot(): Promise<RemoteSnapshot> {
        return {
            protocol: REMOTE_PROTOCOL,
            mac: { name: this.options.backend.macName(), version: this.options.backend.version },
            ...await this.options.backend.snapshot()
        };
    }

    private async agents(): Promise<RemoteAgent[]> {
        return (await this.options.backend.sessions()).filter(session => session.isAgent).map(agentOf);
    }

    private async sendAgents(): Promise<void> {
        if (this.eventStreams.size === 0) return;
        const agents = await this.agents().catch(() => undefined);
        if (!agents) return;
        for (const stream of this.eventStreams) this.sendEvent(stream.response, 'agents', agents);
    }

    private async openEvents(device: RemoteDevice, response: ServerResponse): Promise<void> {
        startStream(response);
        const stream: Stream = { response, deviceId: device.id };
        this.eventStreams.add(stream);
        this.options.backend.onStatusChanged();
        response.on('close', () => {
            this.eventStreams.delete(stream);
            this.options.backend.onStatusChanged();
        });
        this.sendEvent(response, 'agents', await this.agents());
    }

    private async agentSession(id: string): Promise<TerminalSession> {
        const session = (await this.options.backend.sessions()).find(item => item.id === id);
        if (!session || !session.isAgent) {
            throw new HttpError(404, 'This agent does not exist. It possibly closed.');
        }
        return session;
    }

    private async openScreen(device: RemoteDevice, id: string, response: ServerResponse): Promise<void> {
        const session = await this.agentSession(id);
        const entry = await this.mirrorFor(session);
        startStream(response);
        const stream: Stream = { response, deviceId: device.id };
        entry.viewers.add(stream);
        clearTimeout(entry.idleTimer);
        response.on('close', () => {
            entry.viewers.delete(stream);
            if (entry.viewers.size === 0) {
                entry.idleTimer = setTimeout(() => this.disposeMirror(id), MIRROR_IDLE_MS);
            }
        });
        if (!entry.queue) {
            this.sendEvent(response, 'screen', entry.mirror.snapshot());
        }
        if (session.exited) this.sendEvent(response, 'exit', {});
    }

    private async mirrorFor(session: TerminalSession): Promise<MirrorEntry> {
        const existing = this.mirrors.get(session.id);
        if (existing) return existing;
        const mirror = new ScreenMirror(session.cols ?? DEFAULT_SIZE.cols, session.rows ?? DEFAULT_SIZE.rows);
        const entry: MirrorEntry = { mirror, viewers: new Set(), queue: [], lastSentAt: 0 };
        this.mirrors.set(session.id, entry);
        void (async () => {
            try {
                const replay = await this.options.backend.replay(session.id);
                await mirror.write(replay.data, replay.seq);
            } catch {
                // Without a replay, the mirror shows only new output.
            }
            const queue = entry.queue ?? [];
            entry.queue = undefined;
            for (const chunk of queue) await mirror.write(chunk.data, chunk.seq);
            this.scheduleScreen(session.id);
        })();
        return entry;
    }

    private scheduleScreen(id: string): void {
        const entry = this.mirrors.get(id);
        if (!entry || entry.timer || entry.viewers.size === 0) return;
        const wait = Math.max(0, entry.lastSentAt + SCREEN_INTERVAL_MS - Date.now());
        entry.timer = setTimeout(() => {
            entry.timer = undefined;
            entry.lastSentAt = Date.now();
            const json = JSON.stringify(entry.mirror.snapshot());
            if (json === entry.lastJson) return;
            entry.lastJson = json;
            for (const stream of entry.viewers) stream.response.write(`event: screen\ndata: ${json}\n\n`);
        }, wait);
    }

    private disposeMirror(id: string): void {
        const entry = this.mirrors.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        clearTimeout(entry.idleTimer);
        entry.mirror.dispose();
        this.mirrors.delete(id);
    }

    private async input(id: string, input: RemoteInput): Promise<void> {
        const session = await this.agentSession(id);
        if (session.exited) {
            throw new HttpError(409, 'This agent has ended.');
        }
        const mirror = this.mirrors.get(id)?.mirror;
        const writes = inputWrites(input ?? {}, {
            bracketedPaste: mirror?.bracketedPaste ?? false,
            applicationCursorKeys: mirror?.applicationCursorKeys ?? false
        });
        for (const [index, data] of writes.entries()) {
            if (index > 0) await new Promise(resolve => setTimeout(resolve, SUBMIT_DELAY_MS));
            this.options.backend.write(id, data);
        }
    }

    private sendEvent(response: ServerResponse, event: string, data: unknown): void {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
}

function bearerToken(request: IncomingMessage): string | undefined {
    const header = request.headers.authorization;
    return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
}

function startStream(response: ServerResponse): void {
    response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
    });
    response.write(': open\n\n');
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) throw new HttpError(413, 'The request is too large.');
        chunks.push(chunk as Buffer);
    }
    if (size === 0) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new HttpError(400, 'The request is not valid JSON.');
    }
}
