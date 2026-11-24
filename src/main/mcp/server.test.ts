import { afterEach, describe, expect, it } from 'vitest';
import type { ToolHost } from './protocol';
import { bearerToken, blockedOrigin, McpHttpServer } from './server';

const TOKEN = 'good-token';
let server: McpHttpServer | undefined;
let signals: AbortSignal[] = [];

const tools: ToolHost = {
    definitions: () => [],
    call: async (name, _args, context) => {
        signals.push(context.signal);
        if (name === 'wait') {
            await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
            return { content: [{ type: 'text', text: 'stopped' }], isError: true };
        }
        return name === 'where' ? { content: [{ type: 'text', text: context.worktree }] } : undefined;
    }
};

async function start() {
    server = new McpHttpServer({
        identify: async token => (token === TOKEN ? { worktree: '/w/a' } : undefined),
        tools,
        info: { name: 'shipwarden', title: 'ShipWarden', version: '1.0.0' }
    });
    return server.start();
}

/** The parts of the answers that the tests read. */
interface Answer {
    error?: string | { code: number };
    result?: { protocolVersion?: string; content: { text: string }[] };
}
const json = async (response: Response): Promise<Answer> => (await response.json()) as Answer;

function post(url: string, body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) {
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body)
    });
}

const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
};

afterEach(() => {
    server?.stop();
    server = undefined;
    signals = [];
});

describe('McpHttpServer tokens', () => {
    it('rejects a request with no token with 401', async () => {
        const { url } = await start();
        const response = await post(url, initialize, {});
        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toContain('Bearer');
        expect(await json(response)).toEqual({ error: 'The request has no bearer token.' });
    });

    it('rejects a request with a wrong token with 401', async () => {
        const { url } = await start();
        const response = await post(url, initialize, { Authorization: 'Bearer wrong-token' });
        expect(response.status).toBe(401);
        expect(String((await json(response)).error)).toContain('not valid');
        const basic = await post(url, initialize, { Authorization: `Basic ${TOKEN}` });
        expect(basic.status).toBe(401);
    });

    it('accepts a request with the right token, and the tools get the worktree of the token', async () => {
        const { url } = await start();
        const response = await post(url, initialize);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('application/json');
        const body = await json(response);
        expect(body.result?.protocolVersion).toBe('2025-06-18');
        const call = await post(
            url,
            { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'where', arguments: {} } },
            {
                Authorization: `Bearer ${TOKEN}`,
                'MCP-Protocol-Version': '2025-06-18'
            }
        );
        expect((await json(call)).result?.content[0].text).toBe('/w/a');
    });
});

describe('McpHttpServer transport', () => {
    it('listens on 127.0.0.1 with the /mcp path', async () => {
        const { url } = await start();
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        const other = await fetch(url.replace('/mcp', '/other'), { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
        expect(other.status).toBe(404);
    });

    it('answers a notification with 202 and no body', async () => {
        const { url } = await start();
        const response = await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' });
        expect(response.status).toBe(202);
        expect(await response.text()).toBe('');
    });

    it('answers GET and DELETE with 405, because it has no event stream and no session', async () => {
        const { url } = await start();
        const get = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' } });
        expect(get.status).toBe(405);
        expect(get.headers.get('allow')).toBe('POST');
        expect((await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
    });

    it('rejects an unsupported protocol version header with 400', async () => {
        const { url } = await start();
        const response = await post(url, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: `Bearer ${TOKEN}`, 'MCP-Protocol-Version': '1999-01-01' });
        expect(response.status).toBe(400);
    });

    it('answers a body that is not JSON with a parse error', async () => {
        const { url } = await start();
        const response = await post(url, '{nope');
        expect(response.status).toBe(400);
        expect((await json(response)).error).toMatchObject({ code: -32700 });
    });

    it('rejects a request from a page of another site', async () => {
        const { url } = await start();
        const response = await post(url, initialize, { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' });
        expect(response.status).toBe(403);
    });

    it('stops a running tool call on notifications/cancelled', async () => {
        const { url } = await start();
        const running = post(url, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'wait' } });
        await expect.poll(() => signals.length).toBe(1);
        const cancel = await post(url, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9, reason: 'User stopped it.' } });
        expect(cancel.status).toBe(202);
        expect((await json(await running)).result?.content[0].text).toBe('stopped');
        expect(signals[0].aborted).toBe(true);
    });

    it('tries the preferred port first and takes another port when it is busy', async () => {
        const first = await start();
        const second = new McpHttpServer({ identify: async () => undefined, tools, info: { name: 's', title: 'S', version: '1' } });
        try {
            const address = await second.start(first.port);
            expect(address.port).not.toBe(first.port);
        } finally {
            second.stop();
        }
    });
});

describe('bearerToken', () => {
    it('reads the token of a Bearer header', () => {
        expect(bearerToken('Bearer abc')).toBe('abc');
        expect(bearerToken('bearer abc ')).toBe('abc');
        expect(bearerToken('Basic abc')).toBe('');
        expect(bearerToken(undefined)).toBe('');
    });
});

describe('blockedOrigin', () => {
    it('lets programs and local pages through, and blocks other sites', () => {
        expect(blockedOrigin(undefined)).toBe(false);
        expect(blockedOrigin('http://127.0.0.1:3000')).toBe(false);
        expect(blockedOrigin('http://localhost:5173')).toBe(false);
        expect(blockedOrigin('https://evil.example')).toBe(true);
        expect(blockedOrigin('null')).toBe(true);
    });
});
