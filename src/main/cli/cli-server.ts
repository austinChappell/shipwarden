import { timingSafeEqual } from 'crypto';
import { chmodSync, mkdirSync, unlinkSync } from 'fs';
import { connect, createServer, type Server, type Socket } from 'net';
import { dirname } from 'path';
import { CLI_PROTOCOL, isCliCommand, type CliErrorCode, type CliRequest, type CliResponse, type CliResult } from '@shared/cli';

/** A request line that is longer than this is not a request of the CLI. */
const MAX_REQUEST_BYTES = 1024 * 1024;

/** An error with a code for the CLI. Other errors get the code "failed". */
export class CliError extends Error {
    constructor(
        readonly code: CliErrorCode,
        message: string
    ) {
        super(message);
    }
}

/** Runs the commands. The app has one. The background helper can have another one later. */
export interface CliHandler {
    /** Runs a valid request with a valid token. The signal aborts when the CLI closes the connection. */
    handle(request: CliRequest, signal: AbortSignal): Promise<CliResult>;
}

/** Returns true when the two tokens are the same. The time of the check does not tell where they differ. */
export function sameToken(given: unknown, expected: string): boolean {
    if (typeof given !== 'string' || !expected) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

/** Checks a parsed request line. Returns the request, or the error answer. */
export function checkRequest(value: unknown, token: string): CliRequest | CliResponse {
    const fail = (code: CliErrorCode, message: string): CliResponse => ({ ok: false, error: { code, message } });
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('badRequest', 'The request is not a JSON object.');
    const request = value as Partial<CliRequest>;
    // The token check is first, so a caller without the token learns nothing about the server.
    if (!sameToken(request.token, token)) {
        return fail('unauthorized', request.token ? 'The token is not valid. Start ShipWarden again, then try again.' : 'The request has no token.');
    }
    if (request.protocol !== CLI_PROTOCOL) {
        return fail(
            'badRequest',
            `The CLI uses protocol ${String(request.protocol)}, and the app uses protocol ${CLI_PROTOCOL}. Install the shipwarden command again in Settings › Agents.`
        );
    }
    if (!isCliCommand(request.command)) return fail('badRequest', `The app does not know the command "${String(request.command)}".`);
    const args = request.args && typeof request.args === 'object' && !Array.isArray(request.args) ? request.args : {};
    const cwd = typeof request.cwd === 'string' ? request.cwd : '';
    return { protocol: CLI_PROTOCOL, token: request.token as string, command: request.command, args, cwd };
}

function isResponse(value: CliRequest | CliResponse): value is CliResponse {
    return 'ok' in value;
}

function socketIsLive(socketPath: string): Promise<boolean> {
    return new Promise(resolve => {
        const socket = connect(socketPath);
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
    });
}

export interface CliServerOptions {
    socketPath: string;
    /** The token that each request must have. */
    token: string;
    handler: CliHandler;
}

/**
 * The local socket of the `shipwarden` command. Each connection carries one request line and one answer line, both
 * JSON. The socket file has mode 0600, so only the user can connect. Each request must have the token too.
 * The server uses no Electron API, so the background helper can run it later.
 */
export class CliServer {
    private server: Server | undefined;
    private readonly sockets = new Set<Socket>();

    constructor(private readonly options: CliServerOptions) {}

    async start(): Promise<void> {
        const { socketPath } = this.options;
        if (await socketIsLive(socketPath)) throw new Error(`Another ShipWarden listens on ${socketPath}.`);
        try {
            unlinkSync(socketPath);
        } catch {
            // There was no socket file.
        }
        mkdirSync(dirname(socketPath), { recursive: true });
        await new Promise<void>((resolve, reject) => {
            const server = createServer(socket => this.accept(socket));
            server.once('error', reject);
            server.listen(socketPath, () => {
                server.removeListener('error', reject);
                chmodSync(socketPath, 0o600);
                this.server = server;
                resolve();
            });
        });
    }

    stop(): void {
        this.sockets.forEach(socket => socket.destroy());
        this.sockets.clear();
        this.server?.close();
        this.server = undefined;
        try {
            unlinkSync(this.options.socketPath);
        } catch {
            // The socket file is already removed.
        }
    }

    private accept(socket: Socket): void {
        this.sockets.add(socket);
        const controller = new AbortController();
        let buffer = '';
        let started = false;
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
            if (started) return;
            buffer += chunk;
            const end = buffer.indexOf('\n');
            if (end < 0) {
                if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
                    started = true;
                    this.reply(socket, { ok: false, error: { code: 'badRequest', message: 'The request is too large.' } });
                }
                return;
            }
            started = true;
            void this.run(buffer.slice(0, end), controller.signal).then(response => this.reply(socket, response));
        });
        // The CLI closed the connection, for example after Ctrl-C. The command stops its work.
        socket.on('close', () => {
            this.sockets.delete(socket);
            controller.abort();
        });
        socket.on('error', () => undefined);
    }

    private async run(line: string, signal: AbortSignal): Promise<CliResponse> {
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            return { ok: false, error: { code: 'badRequest', message: 'The request is not valid JSON.' } };
        }
        const checked = checkRequest(value, this.options.token);
        if (isResponse(checked)) return checked;
        try {
            return { ok: true, result: await this.options.handler.handle(checked, signal) };
        } catch (error) {
            const code = error instanceof CliError ? error.code : 'failed';
            return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } };
        }
    }

    private reply(socket: Socket, response: CliResponse): void {
        if (socket.destroyed) return;
        socket.end(`${JSON.stringify(response)}\n`);
    }
}
