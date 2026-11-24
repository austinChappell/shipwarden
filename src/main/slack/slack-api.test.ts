import { describe, expect, it } from 'vitest';
import { SlackApi, SlackApiError } from './slack-api';

function fakeFetch(answers: unknown[], status = 200) {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return new Response(JSON.stringify(answers.shift() ?? { ok: true }), { status });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, requests };
}

describe('SlackApi', () => {
    it('sends form values with the token in the header, and waits for the network certificates', async () => {
        let ready = false;
        const { fetch, requests } = fakeFetch([{ ok: true, channel: 'C1', ts: '1.0' }]);
        const api = new SlackApi({
            fetch,
            ready: Promise.resolve().then(() => {
                ready = true;
            })
        });
        expect(await api.post('xoxb-1', 'C1', 'Hi & bye', '0.5')).toEqual({ channel: 'C1', ts: '1.0' });
        expect(ready).toBe(true);
        expect(requests[0].url).toBe('https://slack.com/api/chat.postMessage');
        expect((requests[0].init.headers as Record<string, string>).authorization).toBe('Bearer xoxb-1');
        expect(Object.fromEntries(new URLSearchParams(String(requests[0].init.body)))).toEqual({
            channel: 'C1',
            text: 'Hi & bye',
            thread_ts: '0.5',
            unfurl_links: 'false',
            unfurl_media: 'false'
        });
    });

    it('throws an error with the Slack code and a text for people', async () => {
        const { fetch } = fakeFetch([
            { ok: false, error: 'invalid_auth' },
            { ok: false, error: 'missing_scope', needed: 'channels:join' }
        ]);
        const api = new SlackApi({ fetch });
        await expect(api.identity('xoxb-1')).rejects.toMatchObject({ code: 'invalid_auth', message: expect.stringContaining('does not accept the token') });
        await expect(api.join('xoxb-1', 'C1')).rejects.toThrow('Missing: channels:join.');
    });

    it('reads all pages of the channel list', async () => {
        const { fetch, requests } = fakeFetch([
            { ok: true, channels: [{ id: 'C1', name: 'general' }], response_metadata: { next_cursor: 'next' } },
            { ok: true, channels: [{ id: 'G2', name: 'secret', is_private: true }], response_metadata: { next_cursor: '' } }
        ]);
        expect(await new SlackApi({ fetch }).channels('xoxb-1')).toEqual([
            { id: 'C1', name: 'general', isPrivate: false },
            { id: 'G2', name: 'secret', isPrivate: true }
        ]);
        expect(new URLSearchParams(String(requests[1].init.body)).get('cursor')).toBe('next');
    });

    it('reports a rate limit', async () => {
        const { fetch } = fakeFetch([{}], 429);
        await expect(new SlackApi({ fetch }).socketUrl('xapp-1')).rejects.toBeInstanceOf(SlackApiError);
    });
});
