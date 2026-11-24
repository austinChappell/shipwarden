import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { MCP_PATH } from '@shared/mcp';
import { handleMessage, isNotification, RpcError, SUPPORTED_PROTOCOL_VERSIONS, type ServerInfo, type ToolHost } from './protocol';

const MAX_BODY_BYTES = 1024 * 1024;

export interface McpServerOptions {
    /** Returns the worktree and the session of a token, or undefined for a token that is not valid. */
    identify(token: string): Promise<TokenIdentity | undefined>;
    tools: ToolHost;
    info: ServerInfo;
}

/** The worktree of a token, and the terminal session of its agent when ShipWarden knows it. */
export interface TokenIdentity {
    worktree: string;
    sessionId?: string;
}

export interface McpServerAddress {
    port: number;
    /** The URL of the MCP endpoint, for example "http://127.0.0.1:52000/mcp". */
    url: string;
}

/** Returns the bearer token of the Authorization header, or an empty text. */
export function bearerToken(header: string | string[] | undefined): string {
    const value = Array.isArray(header) ? header[0] : header;
    const match = /^Bearer\s+(\S+)\s*$/i.exec(value ?? '');
    return match ? match[1] : '';
}

/**
 * Returns true when a browser page may not send the request. A request without an Origin header comes from a program,
 * not from a page. A page of another site must not reach the server (DNS rebinding), so only a local origin passes.
 */
export function blockedOrigin(origin: string | undefined): boolean {
    if (!origin) return false;
    try {
        const { hostname } = new URL(origin);
        return hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]';
    } catch {
        return true;
    }
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    if (response.headersSent) return;
    const text = JSON.stringify(body);
    response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers }).end(text);
}

/**
 * The ShipWarden MCP server with the Streamable HTTP transport. It listens only on 127.0.0.1.
 * - POST /mcp takes one JSON-RPC message. A request gets an `application/json` answer. A notification gets 202.
 * - Each request needs `Authorization: Bearer <token>`. No token or a wrong token gets 401.
 * - The server has no SSE stream, so GET gets 405. It keeps no MCP session, so DELETE gets 405 too.
 */
export class McpHttpServer {
    private server: Server | undefined;
    /** The tool calls that run now, by token and request ID. A "notifications/cancelled" stops one. */
    private readonly running = new Map<string, AbortController>();

    constructor(private readonly options: McpServerOptions) {}

    /** Starts the server. It tries `preferredPort` first. When that port is busy, it takes a random port. */
    async start(preferredPort?: number): Promise<McpServerAddress> {
        if (preferredPort) {
            try {
                return await this.listen(preferredPort);
            } catch {
                // Another program has the port now.
            }
        }
        return this.listen(0);
    }

    stop(): void {
        this.running.forEach(controller => controller.abort());
        this.running.clear();
        this.server?.close();
        this.server?.closeAllConnections();
        this.server = undefined;
    }

    private listen(port: number): Promise<McpServerAddress> {
        return new Promise((resolve, reject) => {
            const server = createServer((request, response) => {
                void this.handle(request, response).catch(error => {
                    sendJson(response, 500, { jsonrpc: '2.0', id: null, error: { code: RpcError.internal, message: String(error) } });
                });
            });
            server.once('error', reject);
            server.listen(port, '127.0.0.1', () => {
                server.removeListener('error', reject);
                this.server = server;
                const address = server.address() as AddressInfo;
                resolve({ port: address.port, url: `http://127.0.0.1:${address.port}${MCP_PATH}` });
            });
        });
    }

    private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const path = (request.url ?? '').split('?')[0];
        if (path !== MCP_PATH) {
            sendJson(response, 404, { error: 'Not found.' });
            return;
        }
        if (blockedOrigin(request.headers.origin)) {
            sendJson(response, 403, { error: 'The origin of the request is not local.' });
            return;
        }
        const token = bearerToken(request.headers.authorization);
        const identity = token ? await this.options.identify(token) : undefined;
        if (!identity) {
            sendJson(
                response,
                401,
                { error: token ? 'The token is not valid. Start the agent again in ShipWarden.' : 'The request has no bearer token.' },
                { 'WWW-Authenticate': 'Bearer realm="shipwarden"' }
            );
            return;
        }
        if (request.method !== 'POST') {
            sendJson(response, 405, { error: 'Use POST. The server has no event stream.' }, { Allow: 'POST' });
            return;
        }
        const version = request.headers['mcp-protocol-version'];
        if (typeof version === 'string' && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
            sendJson(response, 400, {
                jsonrpc: '2.0',
                id: null,
                error: {
                    code: RpcError.invalidRequest,
                    message: `The protocol version ${version} is not supported. Use ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`
                }
            });
            return;
        }
        const body = await readBody(request);
        if (body === undefined) {
            sendJson(response, 413, { jsonrpc: '2.0', id: null, error: { code: RpcError.invalidRequest, message: 'The request body is too large.' } });
            return;
        }
        let message: unknown;
        try {
            message = JSON.parse(body);
        } catch {
            sendJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: RpcError.parse, message: 'The body is not valid JSON.' } });
            return;
        }
        if (isNotification(message)) {
            this.notification(token, message as { method: string; params?: { requestId?: unknown } });
        }
        const id = (message as { id?: unknown } | null)?.id;
        const key = `${token}\0${String(id)}`;
        const controller = new AbortController();
        // A client that closes the connection does not want the answer. The tool stops its work.
        response.on('close', () => {
            if (!response.writableFinished) controller.abort();
        });
        if (id !== undefined) this.running.set(key, controller);
        try {
            const answer = await handleMessage(message, { ...identity, signal: controller.signal }, this.options.tools, this.options.info);
            if (!answer) {
                response.writeHead(202).end();
                return;
            }
            sendJson(response, answer.error && answer.id === null ? 400 : 200, answer);
        } finally {
            if (this.running.get(key) === controller) this.running.delete(key);
        }
    }

    private notification(token: string, message: { method: string; params?: { requestId?: unknown } }): void {
        if (message.method !== 'notifications/cancelled') return;
        const key = `${token}\0${String(message.params?.requestId)}`;
        this.running.get(key)?.abort();
    }
}

/** Reads the body of a request. Returns undefined when it is larger than the limit. */
function readBody(request: IncomingMessage): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        request.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                tooLarge = true;
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => resolve(tooLarge ? undefined : Buffer.concat(chunks).toString('utf8')));
        request.on('error', reject);
    });
}
