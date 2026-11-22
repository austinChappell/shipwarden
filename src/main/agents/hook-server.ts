import { randomBytes, timingSafeEqual } from 'crypto';
import { chmodSync, unlinkSync } from 'fs';
import { createServer, type Server } from 'http';

const MAX_BODY_BYTES = 1024 * 1024;

export interface HookServerAddress {
    /** The path of the Unix socket. */
    socket: string;
    token: string;
}

/** Removes a file. Does nothing when the file is not there. */
function removeFile(path: string): void {
    try {
        unlinkSync(path);
    } catch {
        // The file is not there.
    }
}

/**
 * Receives Claude Code hook events from the agent terminals.
 * It listens only on a Unix socket that only the user can open. Each request must also have the random token of this host run.
 * The path is /hook/<session ID>/<event>. The body is the hook's JSON input.
 *
 * The body contains the commands and the file paths of the agent's tools. Do not send it over TCP, also not on
 * 127.0.0.1. Network security tools (for example Bitdefender) read plain HTTP on the loopback interface. They see
 * shell commands and file paths, and they report a command injection or a file inclusion attack.
 * Traffic on a Unix socket does not go through the network stack, so these tools do not see it.
 */
export class HookServer {
    private server: Server | undefined;
    private socketPath: string | undefined;
    private readonly token = randomBytes(24).toString('hex');

    constructor(private readonly onEvent: (sessionId: string, event: string, payload: Record<string, unknown>) => void) {}

    /** Listens on the Unix socket `socketPath`. A socket file that a stopped host left is removed first. */
    start(socketPath: string): Promise<HookServerAddress> {
        removeFile(socketPath);
        return new Promise((resolve, reject) => {
            const server = createServer((request, response) => {
                const match = /^\/hook\/([^/]+)\/([A-Za-z]+)$/.exec(request.url ?? '');
                const token = String(request.headers['x-shipwarden-token'] ?? request.headers['x-yardmaster-token'] ?? '');
                if (request.method !== 'POST' || !match || !this.validToken(token)) {
                    response.writeHead(404).end();
                    return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                request.on('data', (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > MAX_BODY_BYTES) {
                        request.destroy();
                        return;
                    }
                    chunks.push(chunk);
                });
                request.on('end', () => {
                    let payload: Record<string, unknown> = {};
                    try {
                        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                    } catch {
                        // A hook without a JSON body still reports its event.
                    }
                    response.writeHead(204).end();
                    this.onEvent(decodeURIComponent(match[1]), match[2], payload);
                });
            });
            server.once('error', reject);
            server.listen(socketPath, () => {
                try {
                    chmodSync(socketPath, 0o600);
                } catch (error) {
                    server.close();
                    reject(error);
                    return;
                }
                this.server = server;
                this.socketPath = socketPath;
                resolve({ socket: socketPath, token: this.token });
            });
        });
    }

    stop(): void {
        this.server?.close();
        this.server = undefined;
        if (this.socketPath) {
            removeFile(this.socketPath);
            this.socketPath = undefined;
        }
    }

    private validToken(value: string): boolean {
        const expected = Buffer.from(this.token);
        const actual = Buffer.from(value);
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    }
}
