import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitLabClient, GitLabError } from './gitlab-client';

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

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function client(options: { saved?: string; baseUrl?: string; cli?: (host: string) => Promise<string>; answers?: Response[] } = {}) {
    const fake = fakeFetch(options.answers ?? []);
    const instance = new GitLabClient({
        ready: Promise.resolve(),
        baseUrl: () => options.baseUrl,
        savedToken: async () => options.saved,
        cliToken: options.cli ?? (async () => Promise.reject(new Error('no glab'))),
        fetch: fake.fetch
    });
    return { client: instance, calls: fake.calls };
}

describe('GitLabClient', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('sends the saved token as a Bearer token to the API of gitlab.com', async () => {
        const { client: gitlab, calls } = client({ saved: 'glpat-123', answers: [json({ username: 'dana' })] });
        expect(await gitlab.request('GET', '/user')).toEqual({ username: 'dana' });
        expect(calls[0].url).toBe('https://gitlab.com/api/v4/user');
        expect(calls[0].headers.Authorization).toBe('Bearer glpat-123');
        expect(await gitlab.tokenSource()).toBe('saved');
    });

    it('uses the URL of a self-hosted server and sends a JSON body', async () => {
        const { client: gitlab, calls } = client({ saved: 't', baseUrl: 'git.example.com/', answers: [json({ iid: 5 }, 201)] });
        await gitlab.request('POST', '/projects/team%2Fweb/merge_requests', { title: 'x' });
        expect(calls[0]).toMatchObject({ url: 'https://git.example.com/api/v4/projects/team%2Fweb/merge_requests', method: 'POST', body: '{"title":"x"}' });
        expect(calls[0].headers['Content-Type']).toBe('application/json');
        expect(gitlab.host()).toBe('git.example.com');
    });

    it('takes the token of the glab CLI for the host of the server', async () => {
        const hosts: string[] = [];
        const { client: gitlab, calls } = client({
            baseUrl: 'https://git.example.com',
            cli: async host => {
                hosts.push(host);
                return 'oauth-token';
            },
            answers: [json([])]
        });
        await gitlab.request('GET', '/projects');
        expect(hosts).toEqual(['git.example.com']);
        expect(calls[0].headers.Authorization).toBe('Bearer oauth-token');
        expect(await gitlab.tokenSource()).toBe('cli');
    });

    it('uses GITLAB_TOKEN only for gitlab.com', async () => {
        vi.stubEnv('GITLAB_TOKEN', 'env-token');
        expect(await client().client.tokenSource()).toBe('env');
        expect(await client({ baseUrl: 'https://git.example.com' }).client.tokenSource()).toBeUndefined();
    });

    it('reads all pages of a list with the next page header', async () => {
        const { client: gitlab, calls } = client({
            saved: 't',
            answers: [json([{ id: 1 }, { id: 2 }], 200, { 'x-next-page': '2' }), json([{ id: 3 }], 200, { 'x-next-page': '' })]
        });
        expect(await gitlab.all<{ id: number }>('/projects/1/merge_requests/2/discussions')).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
        expect(calls.map(call => call.url)).toEqual([
            'https://gitlab.com/api/v4/projects/1/merge_requests/2/discussions?per_page=100&page=1',
            'https://gitlab.com/api/v4/projects/1/merge_requests/2/discussions?per_page=100&page=2'
        ]);
    });

    it('returns the raw text of a job log', async () => {
        const { client: gitlab } = client({
            saved: 't',
            answers: [new Response('line 1\nline 2', { status: 200, headers: { 'content-type': 'text/plain' } })]
        });
        expect(await gitlab.text('/projects/1/jobs/9/trace')).toBe('line 1\nline 2');
    });

    it('reports an error with the message of GitLab and the path without the query', async () => {
        const { client: gitlab } = client({ saved: 't', answers: [json({ message: '404 Project Not Found' }, 404)] });
        const error = await gitlab.request('GET', '/projects/x?statistics=true').catch((err: unknown) => err);
        expect(error).toBeInstanceOf(GitLabError);
        expect((error as GitLabError).status).toBe(404);
        expect((error as Error).message).toBe('GitLab returned 404 for GET /projects/x. 404 Project Not Found');
    });

    it('tells the user to fix the token after a 401, and gets a new token for the next request', async () => {
        let count = 0;
        const { client: gitlab } = client({
            cli: async () => `token-${++count}`,
            answers: [json({ message: '401 Unauthorized' }, 401), json({ username: 'dana' })]
        });
        await expect(gitlab.request('GET', '/user')).rejects.toThrow(/"api" scope.*Settings › Code review/);
        await gitlab.request('GET', '/user');
        expect(count).toBe(2);
    });

    it('explains a network error', async () => {
        const gitlab = new GitLabClient({
            ready: Promise.resolve(),
            baseUrl: () => undefined,
            savedToken: async () => 't',
            fetch: (async () => {
                throw new TypeError('fetch failed', { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } });
            }) as unknown as typeof fetch
        });
        await expect(gitlab.request('GET', '/user')).rejects.toThrow(/cannot connect to GitLab \(gitlab\.com\).*Settings › Network/);
    });

    it('has no token without a saved token, GITLAB_TOKEN, or a glab login', async () => {
        vi.stubEnv('GITLAB_TOKEN', '');
        const { client: gitlab } = client();
        expect(await gitlab.tokenSource()).toBeUndefined();
        await expect(gitlab.request('GET', '/user')).rejects.toThrow(/glab auth login --hostname gitlab\.com/);
    });
});
