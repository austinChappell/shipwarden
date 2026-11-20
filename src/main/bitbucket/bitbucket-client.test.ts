import { afterEach, describe, expect, it, vi } from 'vitest';
import { BitbucketClient, BitbucketError } from './bitbucket-client';

interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
}

/** A fake fetch that records the requests and gives the answers in order. */
function fakeFetch(answers: Response[]) {
    const calls: Call[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
        calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body as string | undefined });
        const answer = answers.shift();
        if (!answer) throw new Error('No more answers.');
        return answer;
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function client(options: { saved?: string; username?: string; answers?: Response[] } = {}) {
    const fake = fakeFetch(options.answers ?? []);
    const instance = new BitbucketClient({
        ready: Promise.resolve(),
        savedToken: async () => options.saved,
        username: () => options.username,
        fetch: fake.fetch
    });
    return { client: instance, calls: fake.calls };
}

describe('BitbucketClient', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('sends an API token with the email as Basic auth', async () => {
        const { client: bitbucket, calls } = client({ saved: 'ATATT-123', username: 'dana@example.com', answers: [json({ nickname: 'dana' })] });
        expect(await bitbucket.request('GET', '/user')).toEqual({ nickname: 'dana' });
        expect(calls[0].url).toBe('https://api.bitbucket.org/2.0/user');
        expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from('dana@example.com:ATATT-123').toString('base64')}`);
        expect(await bitbucket.tokenSource()).toBe('saved');
    });

    it('sends an access token without a username as a Bearer token, with a JSON body', async () => {
        const { client: bitbucket, calls } = client({ saved: 'access-token', answers: [json({ id: 3 }, 201)] });
        await bitbucket.request('POST', '/repositories/acme/api/pullrequests', { title: 'x' });
        expect(calls[0]).toMatchObject({ method: 'POST', body: '{"title":"x"}' });
        expect(calls[0].headers.Authorization).toBe('Bearer access-token');
        expect(calls[0].headers['Content-Type']).toBe('application/json');
    });

    it('uses BITBUCKET_TOKEN and BITBUCKET_USERNAME without a saved token', async () => {
        vi.stubEnv('BITBUCKET_TOKEN', 'env-token');
        vi.stubEnv('BITBUCKET_USERNAME', 'dana@example.com');
        const { client: bitbucket, calls } = client({ answers: [json({})] });
        expect(await bitbucket.tokenSource()).toBe('env');
        await bitbucket.request('GET', '/user');
        expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from('dana@example.com:env-token').toString('base64')}`);
    });

    it('follows the next links of the pages', async () => {
        const { client: bitbucket, calls } = client({
            saved: 't',
            answers: [
                json({ values: [{ id: 1 }, { id: 2 }], next: 'https://api.bitbucket.org/2.0/repositories/acme/api/pullrequests/1/comments?pagelen=50&page=2' }),
                json({ values: [{ id: 3 }] })
            ]
        });
        expect(await bitbucket.all<{ id: number }>('/repositories/acme/api/pullrequests/1/comments')).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
        expect(calls.map(call => call.url)).toEqual([
            'https://api.bitbucket.org/2.0/repositories/acme/api/pullrequests/1/comments?pagelen=50',
            'https://api.bitbucket.org/2.0/repositories/acme/api/pullrequests/1/comments?pagelen=50&page=2'
        ]);
    });

    it('stops after the largest number of pages, and keeps a pagelen in the path', async () => {
        const page = () => json({ values: [{ id: 1 }], next: 'https://api.bitbucket.org/2.0/x?page=2' });
        const { client: bitbucket, calls } = client({ saved: 't', answers: [page(), page(), page()] });
        expect(await bitbucket.all('/x?pagelen=100', 2)).toHaveLength(2);
        expect(calls[0].url).toBe('https://api.bitbucket.org/2.0/x?pagelen=100');
        expect(calls).toHaveLength(2);
    });

    it('does not send the token to another server', async () => {
        const { client: bitbucket, calls } = client({ saved: 't', answers: [json({ values: [{ id: 1 }], next: 'https://evil.example/2.0/x?page=2' })] });
        await expect(bitbucket.all('/x')).rejects.toThrow('does not send the Bitbucket token to evil.example');
        expect(calls).toHaveLength(1);
    });

    it('returns the raw text of a diff', async () => {
        const { client: bitbucket } = client({
            saved: 't',
            answers: [new Response('diff --git a/x b/x\n', { status: 200, headers: { 'content-type': 'text/plain' } })]
        });
        expect(await bitbucket.text('/repositories/acme/api/pullrequests/1/diff')).toBe('diff --git a/x b/x\n');
    });

    it('reports an error with the message of Bitbucket and the path without the query', async () => {
        const { client: bitbucket } = client({
            saved: 't',
            answers: [json({ type: 'error', error: { message: 'Repository not found', detail: 'There is no repository acme/x.' } }, 404)]
        });
        const error = await bitbucket.request('GET', '/repositories/acme/x?fields=name').catch((err: unknown) => err);
        expect(error).toBeInstanceOf(BitbucketError);
        expect((error as BitbucketError).status).toBe(404);
        expect((error as Error).message).toBe('Bitbucket returned 404 for GET /repositories/acme/x. Repository not found. There is no repository acme/x.');
    });

    it('tells the user to fix the token after a 401', async () => {
        const { client: bitbucket } = client({ saved: 't', answers: [json({ type: 'error', error: { message: 'Unauthorized' } }, 401)] });
        await expect(bitbucket.request('GET', '/user')).rejects.toThrow(/Unauthorized\. Make sure that the token.*Settings › Code review/);
    });

    it('explains a network error', async () => {
        const bitbucket = new BitbucketClient({
            ready: Promise.resolve(),
            savedToken: async () => 't',
            username: () => undefined,
            fetch: (async () => {
                throw new TypeError('fetch failed', { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } });
            }) as unknown as typeof fetch
        });
        await expect(bitbucket.request('GET', '/user')).rejects.toThrow(/cannot connect to Bitbucket.*Settings › Network/);
    });

    it('has no token without a saved token or BITBUCKET_TOKEN', async () => {
        vi.stubEnv('BITBUCKET_TOKEN', '');
        const { client: bitbucket } = client();
        expect(await bitbucket.tokenSource()).toBeUndefined();
        await expect(bitbucket.request('GET', '/user')).rejects.toThrow(/no Bitbucket token/);
    });
});
