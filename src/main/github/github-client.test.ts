import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubClient, GitHubError, GitHubRateLimitError } from './github-client';

function client() {
    return new GitHubClient({ ready: Promise.resolve(), savedToken: async () => 'token' });
}

function reply(status: number, body: unknown = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('GitHubClient', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('tries a GET request again after a 502', async () => {
        vi.useFakeTimers();
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(reply(502))
            .mockResolvedValueOnce(reply(200, { id: 1 }));
        vi.stubGlobal('fetch', fetch);
        const result = client().rest('GET', '/repos/a/b');
        await vi.runAllTimersAsync();
        await expect(result).resolves.toEqual({ id: 1 });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('stops after 3 attempts', async () => {
        vi.useFakeTimers();
        const fetch = vi.fn().mockImplementation(async () => reply(502));
        vi.stubGlobal('fetch', fetch);
        const result = client().rest('GET', '/repos/a/b');
        const check = expect(result).rejects.toBeInstanceOf(GitHubError);
        await vi.runAllTimersAsync();
        await check;
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('does not try a POST request again', async () => {
        const fetch = vi.fn().mockResolvedValue(reply(502));
        vi.stubGlobal('fetch', fetch);
        await expect(client().rest('POST', '/repos/a/b/issues', {})).rejects.toMatchObject({ status: 502 });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('pauses all requests after a secondary rate limit', async () => {
        vi.useFakeTimers();
        const fetch = vi.fn().mockResolvedValue(reply(403, { message: 'You have exceeded a secondary rate limit.' }));
        vi.stubGlobal('fetch', fetch);
        const github = client();
        await expect(github.graphql('query { viewer { login } }', {})).rejects.toBeInstanceOf(GitHubRateLimitError);
        await expect(github.rest('GET', '/repos/a/b')).rejects.toBeInstanceOf(GitHubRateLimitError);
        expect(fetch).toHaveBeenCalledTimes(1);

        fetch.mockResolvedValue(reply(200, { id: 1 }));
        vi.advanceTimersByTime(60_000);
        await expect(github.rest('GET', '/repos/a/b')).resolves.toEqual({ id: 1 });
    });

    it('doubles the pause after a second secondary rate limit', async () => {
        vi.useFakeTimers();
        const fetch = vi.fn().mockImplementation(async () => reply(403, { message: 'You have exceeded a secondary rate limit.' }));
        vi.stubGlobal('fetch', fetch);
        const github = client();
        const start = Date.now();
        await expect(github.rest('GET', '/a')).rejects.toMatchObject({ retryAt: start + 60_000 });
        vi.advanceTimersByTime(60_000);
        await expect(github.rest('GET', '/a')).rejects.toMatchObject({ retryAt: start + 60_000 + 120_000 });
    });

    it('waits for the retry-after header', async () => {
        vi.useFakeTimers();
        const response = new Response('{}', { status: 429, headers: { 'retry-after': '30' } });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
        await expect(client().rest('GET', '/a')).rejects.toMatchObject({ retryAt: Date.now() + 30_000 });
    });

    it('waits for the reset time of a used primary limit', async () => {
        const reset = Math.floor(Date.now() / 1000) + 600;
        const response = new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
        await expect(client().rest('GET', '/a')).rejects.toMatchObject({ retryAt: reset * 1000 + 1000 });
    });

    it('pauses after a RATE_LIMITED GraphQL error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] })));
        await expect(client().graphql('query { viewer { login } }', {})).rejects.toBeInstanceOf(GitHubRateLimitError);
    });

    it('does not pause after a 403 that is not a rate limit', async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(reply(403, { message: 'Resource not accessible by integration' }))
            .mockResolvedValueOnce(reply(200, { id: 1 }));
        vi.stubGlobal('fetch', fetch);
        const github = client();
        await expect(github.rest('GET', '/a')).rejects.not.toBeInstanceOf(GitHubRateLimitError);
        await expect(github.rest('GET', '/a')).resolves.toEqual({ id: 1 });
    });

    it('runs at most 2 GraphQL requests at the same time', async () => {
        let active = 0;
        let most = 0;
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(async () => {
                active++;
                most = Math.max(most, active);
                await new Promise(resolve => setTimeout(resolve, 5));
                active--;
                return reply(200, { data: {} });
            })
        );
        const github = client();
        await Promise.all(Array.from({ length: 6 }, () => github.graphql('query { viewer { login } }', {})));
        expect(most).toBe(2);
    });

    it('sends the ETag again and gives the kept body after a 304', async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(JSON.stringify([{ id: 1 }]), {
                    status: 200,
                    headers: { 'content-type': 'application/json', etag: '"v1"', link: '<x>; rel="next"' }
                })
            )
            .mockResolvedValueOnce(new Response(null, { status: 304 }));
        vi.stubGlobal('fetch', fetch);
        const github = client();
        await expect(github.rest('GET', '/repos/a/b/pulls')).resolves.toEqual([{ id: 1 }]);
        await expect(github.rest('GET', '/repos/a/b/pulls')).resolves.toEqual([{ id: 1 }]);
        expect(fetch.mock.calls[0][1].headers['If-None-Match']).toBeUndefined();
        expect(fetch.mock.calls[1][1].headers['If-None-Match']).toBe('"v1"');
    });

    it('does not send an ETag for a GraphQL request or a POST request', async () => {
        const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: {} }), { status: 200, headers: { etag: '"v1"' } }));
        vi.stubGlobal('fetch', fetch);
        const github = client();
        await github.graphql('query { viewer { login } }', {});
        await github.graphql('query { viewer { login } }', {});
        await github.rest('POST', '/repos/a/b/issues', {});
        await github.rest('POST', '/repos/a/b/issues', {});
        for (const call of fetch.mock.calls) {
            expect(call[1].headers['If-None-Match']).toBeUndefined();
        }
    });

    it('forgets the ETags after a reset', async () => {
        const fetch = vi
            .fn()
            .mockImplementation(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json', etag: '"v1"' } }));
        vi.stubGlobal('fetch', fetch);
        const github = client();
        await github.rest('GET', '/a');
        github.reset();
        await github.rest('GET', '/a');
        expect(fetch.mock.calls[1][1].headers['If-None-Match']).toBeUndefined();
    });

    it('does not try a GET request again after a 404', async () => {
        const fetch = vi.fn().mockResolvedValue(reply(404));
        vi.stubGlobal('fetch', fetch);
        await expect(client().rest('GET', '/repos/a/b')).rejects.toMatchObject({ status: 404 });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
