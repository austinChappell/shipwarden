import { describe, expect, it } from 'vitest';
import { handleMessage, LATEST_PROTOCOL_VERSION, negotiateVersion, RpcError, type ToolHost } from './protocol';

const info = { name: 'shipwarden', title: 'ShipWarden', version: '1.2.3', instructions: 'Use the tools.' };
const context = { worktree: '/w/a', signal: new AbortController().signal };
const tools: ToolHost = {
    definitions: () => [
        {
            name: 'echo',
            title: 'Echo',
            description: 'Returns the text.',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        }
    ],
    call: async (name, args, ctx) => {
        if (name === 'boom') throw new Error('Broken.');
        return name === 'echo' ? { content: [{ type: 'text', text: `${ctx.worktree}: ${String(args.text)}` }] } : undefined;
    }
};
const send = (message: unknown) => handleMessage(message, context, tools, info);

describe('negotiateVersion', () => {
    it('keeps a supported version and gives the newest version for another one', () => {
        expect(negotiateVersion('2025-06-18')).toBe('2025-06-18');
        expect(negotiateVersion('2025-03-26')).toBe('2025-03-26');
        expect(negotiateVersion('2024-11-05')).toBe(LATEST_PROTOCOL_VERSION);
        expect(negotiateVersion(undefined)).toBe(LATEST_PROTOCOL_VERSION);
    });
});

describe('handleMessage', () => {
    it('answers initialize with the version, the tools capability, and the server info', async () => {
        const response = await send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code' } }
        });
        expect(response).toEqual({
            jsonrpc: '2.0',
            id: 1,
            result: {
                protocolVersion: '2025-06-18',
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'shipwarden', title: 'ShipWarden', version: '1.2.3' },
                instructions: 'Use the tools.'
            }
        });
    });
    it('gives no answer to a notification or to a response of the client', async () => {
        expect(await send({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
        expect(await send({ jsonrpc: '2.0', id: 4, result: {} })).toBeUndefined();
    });
    it('answers ping and tools/list', async () => {
        expect(await send({ jsonrpc: '2.0', id: 'p', method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 'p', result: {} });
        const list = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        expect((list?.result as { tools: { name: string }[] } | undefined)?.tools.map(tool => tool.name)).toEqual(['echo']);
    });
    it('calls a tool with the worktree of the context', async () => {
        const response = await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } });
        expect(response?.result).toEqual({ content: [{ type: 'text', text: '/w/a: hi' }] });
    });
    it('gives an invalid params error for an unknown tool or a missing name', async () => {
        expect((await send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } }))?.error?.code).toBe(RpcError.invalidParams);
        expect((await send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} }))?.error?.code).toBe(RpcError.invalidParams);
    });
    it('gives an internal error when the tool host throws', async () => {
        expect(await send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'boom' } })).toEqual({
            jsonrpc: '2.0',
            id: 7,
            error: { code: RpcError.internal, message: 'Broken.' }
        });
    });
    it('gives method not found for an unknown method', async () => {
        expect((await send({ jsonrpc: '2.0', id: 8, method: 'resources/list' }))?.error?.code).toBe(RpcError.methodNotFound);
    });
    it('rejects a batch, a message that is not JSON-RPC 2.0, and a null ID', async () => {
        expect((await send([{ jsonrpc: '2.0', id: 1, method: 'ping' }]))?.error?.code).toBe(RpcError.invalidRequest);
        expect((await send({ id: 1, method: 'ping' }))?.error?.code).toBe(RpcError.invalidRequest);
        expect((await send({ jsonrpc: '2.0', id: null, method: 'ping' }))?.error?.code).toBe(RpcError.invalidRequest);
    });
});
