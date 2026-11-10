import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubClient, GitHubError } from './github-client';

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

    it('does not try a GET request again after a 404', async () => {
        const fetch = vi.fn().mockResolvedValue(reply(404));
        vi.stubGlobal('fetch', fetch);
        await expect(client().rest('GET', '/repos/a/b')).rejects.toMatchObject({ status: 404 });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
