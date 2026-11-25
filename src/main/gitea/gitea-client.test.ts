import { afterEach, describe, expect, it, vi } from 'vitest';
import { GiteaClient, PAGE_SIZE } from './gitea-client';

/** A fake fetch that gives the answers in order and keeps the requests. */
function fakeFetch(answers: Response[]) {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        const next = answers.shift();
        if (!next) throw new Error('No more answers.');
        return next;
    }) as unknown as typeof globalThis.fetch;
    return { fetch, requests };
}

function json(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
}

function client(answers: Response[], options: { baseUrl?: string; token?: string } = {}) {
    const fake = fakeFetch(answers);
    const instance = new GiteaClient({
        ready: Promise.resolve(),
        baseUrl: () => ('baseUrl' in options ? options.baseUrl : 'https://git.example.com/'),
        savedToken: async () => ('token' in options ? options.token : 'secret'),
        fetch: fake.fetch
    });
    return { client: instance, ...fake };
}

describe('GiteaClient', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('sends the token in the "token" header to the API of the server', async () => {
        const { client: gitea, requests } = client([json({ login: 'dana' })]);
        expect(await gitea.request('GET', '/user')).toEqual({ login: 'dana' });
        expect(requests[0].url).toBe('https://git.example.com/api/v1/user');
        expect((requests[0].init!.headers as Record<string, string>).Authorization).toBe('token secret');
        expect(await gitea.tokenSource()).toBe('saved');
    });

    it('reads GITEA_TOKEN when no token is saved', async () => {
        vi.stubEnv('GITEA_TOKEN', 'from-env');
        const { client: gitea, requests } = client([json({})], { token: undefined });
        await gitea.request('GET', '/user');
        expect((requests[0].init!.headers as Record<string, string>).Authorization).toBe('token from-env');
        expect(await gitea.tokenSource()).toBe('env');
    });

    it('stops at a page with fewer items than the limit', async () => {
        const full = Array.from({ length: PAGE_SIZE }, (_, index) => ({ id: index }));
        const { client: gitea, requests } = client([json(full, { headers: { link: '<x?page=2>; rel="next"' } }), json([{ id: 99 }])]);
        const items = await gitea.all<{ id: number }>('/repos/acme/api/pulls?state=open');
        expect(items).toHaveLength(PAGE_SIZE + 1);
        expect(requests.map(request => request.url)).toEqual([
            `https://git.example.com/api/v1/repos/acme/api/pulls?state=open&limit=${PAGE_SIZE}&page=1`,
            `https://git.example.com/api/v1/repos/acme/api/pulls?state=open&limit=${PAGE_SIZE}&page=2`
        ]);
    });

    it('stops at a full page without a "next" link', async () => {
        const full = Array.from({ length: PAGE_SIZE }, (_, index) => ({ id: index }));
        const { client: gitea, requests } = client([json(full, { headers: { link: '<x?page=1>; rel="prev"' } })]);
        expect(await gitea.all('/user/repos')).toHaveLength(PAGE_SIZE);
        expect(requests).toHaveLength(1);
    });

    it('gives the message of the server in an error and forgets a refused token', async () => {
        const { client: gitea } = client([json({ message: 'token is required' }, { status: 401 })]);
        await expect(gitea.request('GET', '/user')).rejects.toThrow(
            'git.example.com returned 401 for GET /user. token is required. Make sure that the token is correct.'
        );
    });

    it('needs a server URL', async () => {
        const { client: gitea, requests } = client([], { baseUrl: undefined });
        await expect(gitea.request('GET', '/user')).rejects.toThrow('has no server URL');
        expect(requests).toHaveLength(0);
    });

    it('reads the version one time', async () => {
        const { client: gitea, requests } = client([json({ version: '11.0.1+gitea-1.22.0' })]);
        expect(await gitea.version()).toBe('11.0.1+gitea-1.22.0');
        expect(await gitea.version()).toBe('11.0.1+gitea-1.22.0');
        expect(requests).toHaveLength(1);
    });

    it('tells a connection error from an error of the server', async () => {
        const fetch = vi.fn(async () => {
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        }) as unknown as typeof globalThis.fetch;
        const gitea = new GiteaClient({ ready: Promise.resolve(), baseUrl: () => 'https://git.example.com', savedToken: async () => 'secret', fetch });
        await expect(gitea.request('GET', '/user')).rejects.toThrow('ShipWarden cannot connect to git.example.com');
    });
});
