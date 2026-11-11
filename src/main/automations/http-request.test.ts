import { describe, expect, it, vi } from 'vitest';
import { MAX_RESPONSE_BYTES, httpRequestOf, sendHttpRequest } from './http-request';

const ready = Promise.resolve();

describe('httpRequestOf', () => {
    it('refuses an address that is not http or https', () => {
        expect(() => httpRequestOf({ method: 'GET', url: 'file:///etc/passwd' })).toThrow('http://');
        expect(() => httpRequestOf({ method: 'GET', url: 'not a url' })).toThrow('not a valid web address');
        expect(() => httpRequestOf({ method: 'TRACE', url: 'https://x.test' })).toThrow('not known');
    });

    it('drops the body of a GET request and limits the time', () => {
        expect(httpRequestOf({ method: 'GET', url: 'https://x.test', body: 'x', timeoutSeconds: 9999 })).toEqual({
            method: 'GET',
            url: 'https://x.test/',
            headers: {},
            timeoutSeconds: 300
        });
    });
});

describe('sendHttpRequest', () => {
    it('sends the request and returns the answer', async () => {
        const fetcher = vi.fn(async () => new Response('{"ok":true}', { status: 201, statusText: 'Created', headers: { 'content-type': 'application/json' } }));
        const response = await sendHttpRequest(
            { method: 'POST', url: 'https://x.test/hook', headers: { Authorization: 'Bearer t' }, body: '{}' },
            ready,
            fetcher as unknown as typeof fetch
        );
        expect(response).toEqual({ status: 201, statusText: 'Created', body: '{"ok":true}', truncated: false, contentType: 'application/json' });
        const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://x.test/hook');
        expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer t' }, body: '{}' });
    });

    it('keeps the start of a large body', async () => {
        const big = 'a'.repeat(MAX_RESPONSE_BYTES + 10);
        const fetcher = async () => new Response(big, { status: 200 });
        const response = await sendHttpRequest({ method: 'GET', url: 'https://x.test' }, ready, fetcher as unknown as typeof fetch);
        expect(response.truncated).toBe(true);
        expect(response.body.length).toBe(MAX_RESPONSE_BYTES);
    });

    it('describes a network error with the host', async () => {
        const fetcher = async () => {
            throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
        };
        await expect(sendHttpRequest({ method: 'GET', url: 'https://x.test/a' }, ready, fetcher as unknown as typeof fetch)).rejects.toThrow(
            'GET x.test failed: fetch failed (ECONNREFUSED)'
        );
    });
});
