/**
 * The JSON-RPC part of the ShipWarden MCP server. It knows the MCP methods initialize, ping, tools/list and tools/call.
 * The HTTP part is in `server.ts`. This module uses no Electron API and no network, so the tests call it directly.
 */

/** The newest MCP protocol version that the server knows. */
export const LATEST_PROTOCOL_VERSION = '2025-11-25';

/** The MCP protocol versions that the server supports. The newest is first. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26'];

/** The JSON-RPC error codes. */
export const RpcError = {
    parse: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internal: -32603
} as const;

export type RpcId = string | number;

export interface RpcResponse {
    jsonrpc: '2.0';
    id: RpcId | null;
    result?: unknown;
    error?: { code: number; message: string };
}

/** The description of a tool in the result of tools/list. */
export interface ToolDefinition {
    name: string;
    title: string;
    description: string;
    inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
    annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

/** The result of tools/call. A failure of the tool is a result with `isError`, not a JSON-RPC error. */
export interface ToolResult {
    /** An image item has the image data in base64, for example of a PNG. */
    content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
}

/** The facts of a request: the worktree of the token, and a signal that stops the work when the client goes away. */
export interface ToolContext {
    worktree: string;
    /** The terminal session of the agent. Undefined until ShipWarden connects the token to its session. */
    sessionId?: string;
    signal: AbortSignal;
}

/** The tools of the server. `call` returns undefined for an unknown tool. */
export interface ToolHost {
    definitions(): ToolDefinition[];
    call(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult | undefined>;
}

export interface ServerInfo {
    name: string;
    title: string;
    version: string;
    instructions?: string;
}

/**
 * Returns the protocol version for the answer to initialize. A supported version stays. For another version, the
 * server answers with its newest version, and the client decides if it can use it.
 */
export function negotiateVersion(requested: unknown): string {
    return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

/** Returns true for a request or a notification of JSON-RPC 2.0. A response from the client is not a message for the server. */
function isMessage(value: unknown): value is { jsonrpc: '2.0'; method: string; id?: unknown; params?: unknown } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const message = value as Record<string, unknown>;
    return message.jsonrpc === '2.0' && typeof message.method === 'string';
}

/** Returns true when the value is a response of the client (it has a result or an error and no method). */
export function isClientResponse(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const message = value as Record<string, unknown>;
    return message.jsonrpc === '2.0' && typeof message.method !== 'string' && ('result' in message || 'error' in message);
}

/** Returns true when the message is a notification: it has a method and no ID. The server sends no answer to it. */
export function isNotification(value: unknown): boolean {
    return isMessage(value) && !('id' in value);
}

function errorResponse(id: RpcId | null, code: number, message: string): RpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Handles one JSON-RPC message. Returns the response, or undefined for a notification or a response of the client.
 * A batch (an array) is not part of MCP since version 2025-06-18, so it gets an error.
 */
export async function handleMessage(message: unknown, context: ToolContext, tools: ToolHost, info: ServerInfo): Promise<RpcResponse | undefined> {
    if (Array.isArray(message)) return errorResponse(null, RpcError.invalidRequest, 'The server does not accept a batch. Send one message in each request.');
    if (isClientResponse(message)) return undefined;
    if (!isMessage(message)) return errorResponse(null, RpcError.invalidRequest, 'The message is not a JSON-RPC 2.0 request.');
    if (!('id' in message)) return undefined;
    const id = message.id;
    if (typeof id !== 'string' && typeof id !== 'number') return errorResponse(null, RpcError.invalidRequest, 'The request ID must be a string or a number.');
    const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? (message.params as Record<string, unknown>) : {};
    switch (message.method) {
        case 'initialize':
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: negotiateVersion(params.protocolVersion),
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: info.name, title: info.title, version: info.version },
                    ...(info.instructions ? { instructions: info.instructions } : {})
                }
            };
        case 'ping':
            return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
            return { jsonrpc: '2.0', id, result: { tools: tools.definitions() } };
        case 'tools/call': {
            const name = params.name;
            if (typeof name !== 'string') return errorResponse(id, RpcError.invalidParams, 'The params need the name of the tool.');
            const args =
                params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
                    ? (params.arguments as Record<string, unknown>)
                    : {};
            try {
                const result = await tools.call(name, args, context);
                if (!result) return errorResponse(id, RpcError.invalidParams, `The tool "${name}" does not exist.`);
                return { jsonrpc: '2.0', id, result };
            } catch (error) {
                return errorResponse(id, RpcError.internal, error instanceof Error ? error.message : String(error));
            }
        }
        default:
            return errorResponse(id, RpcError.methodNotFound, `The method "${message.method}" does not exist.`);
    }
}
