import { randomBytes, timingSafeEqual } from 'crypto';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

const MAX_BODY_BYTES = 1024 * 1024;

export interface HookServerAddress {
    url: string;
    token: string;
}

/**
 * Receives Claude Code hook events from the agent terminals.
 * It listens only on 127.0.0.1, and each request must have the random token of this host run.
 * The path is /hook/<session ID>/<event>. The body is the hook's JSON input.
 */
export class HookServer {
    private server: Server | undefined;
    private readonly token = randomBytes(24).toString('hex');

    constructor(private readonly onEvent: (sessionId: string, event: string, payload: Record<string, unknown>) => void) {}

    start(): Promise<HookServerAddress> {
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
            server.listen(0, '127.0.0.1', () => {
                this.server = server;
                const { port } = server.address() as AddressInfo;
                resolve({ url: `http://127.0.0.1:${port}`, token: this.token });
            });
        });
    }

    stop(): void {
        this.server?.close();
        this.server = undefined;
    }

    private validToken(value: string): boolean {
        const expected = Buffer.from(this.token);
        const actual = Buffer.from(value);
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    }
}
