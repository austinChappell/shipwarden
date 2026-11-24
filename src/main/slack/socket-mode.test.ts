import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlackApiError } from './slack-api';
import { SocketModeClient, type SlackEventCallback, type SocketLike, type SocketState } from './socket-mode';

/** A fake WebSocket. The test sends frames and reads the frames of the client. */
class FakeSocket implements SocketLike {
    readonly sent: string[] = [];
    closed = false;
    private readonly listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

    constructor(readonly url: string) {}

    send(data: string): void {
        this.sent.push(data);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.emit('close');
    }

    addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    emit(type: string, data?: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) listener({ data });
    }

    frame(value: unknown): void {
        this.emit('message', JSON.stringify(value));
    }
}

function setup(openUrl: () => Promise<string> = async () => 'wss://slack.example/1') {
    const sockets: FakeSocket[] = [];
    const events: SlackEventCallback[] = [];
    const states: { state: SocketState; error?: string }[] = [];
    const client = new SocketModeClient({
        openUrl,
        socket: url => {
            const socket = new FakeSocket(url);
            sockets.push(socket);
            return socket;
        },
        onEvent: payload => events.push(payload),
        onState: (state, error) => states.push(error ? { state, error } : { state }),
        log: () => undefined,
        retryDelayMs: () => 1000
    });
    return { client, sockets, events, states };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

afterEach(() => {
    vi.useRealTimers();
});

describe('SocketModeClient', () => {
    it('connects to the address of apps.connections.open and reports "connected" at hello', async () => {
        const { client, sockets, states } = setup();
        client.start();
        await flush();
        expect(sockets.map(socket => socket.url)).toEqual(['wss://slack.example/1']);
        sockets[0].frame({ type: 'hello', num_connections: 1 });
        expect(states).toEqual([{ state: 'connecting' }, { state: 'connected' }]);
        client.stop();
    });

    it('acknowledges an events_api envelope before it gives the event', async () => {
        const order: string[] = [];
        const sockets: FakeSocket[] = [];
        const events: SlackEventCallback[] = [];
        const client = new SocketModeClient({
            openUrl: async () => 'wss://x',
            socket: url => {
                const socket = new FakeSocket(url);
                const send = socket.send.bind(socket);
                socket.send = data => {
                    order.push('ack');
                    send(data);
                };
                sockets.push(socket);
                return socket;
            },
            onEvent: payload => {
                order.push('event');
                events.push(payload);
            },
            onState: () => undefined,
            log: () => undefined
        });
        client.start();
        await flush();
        const payload = { event_id: 'Ev1', event: { type: 'app_mention', text: 'hi' } };
        sockets[0].frame({ envelope_id: 'env-1', type: 'events_api', payload, accepts_response_payload: false });
        expect(sockets[0].sent).toEqual([JSON.stringify({ envelope_id: 'env-1' })]);
        expect(events).toEqual([payload]);
        expect(order).toEqual(['ack', 'event']);
        client.stop();
    });

    it('acknowledges other envelopes with an ID and ignores frames that are not JSON', async () => {
        const { client, sockets, events } = setup();
        client.start();
        await flush();
        sockets[0].frame({ envelope_id: 'env-2', type: 'slash_commands', payload: {} });
        sockets[0].emit('message', 'not json');
        expect(sockets[0].sent).toEqual([JSON.stringify({ envelope_id: 'env-2' })]);
        expect(events).toEqual([]);
        client.stop();
    });

    it('acknowledges the envelope also when the event handler throws', async () => {
        const sockets: FakeSocket[] = [];
        const client = new SocketModeClient({
            openUrl: async () => 'wss://x',
            socket: url => {
                const socket = new FakeSocket(url);
                sockets.push(socket);
                return socket;
            },
            onEvent: () => {
                throw new Error('boom');
            },
            onState: () => undefined,
            log: () => undefined
        });
        client.start();
        await flush();
        sockets[0].frame({ envelope_id: 'env-3', type: 'events_api', payload: { event: { type: 'message' } } });
        expect(sockets[0].sent).toEqual([JSON.stringify({ envelope_id: 'env-3' })]);
        client.stop();
    });

    it('connects again after a "disconnect" envelope', async () => {
        vi.useFakeTimers();
        let count = 0;
        const { client, sockets } = setup(async () => `wss://slack.example/${++count}`);
        client.start();
        await vi.advanceTimersByTimeAsync(0);
        sockets[0].frame({ type: 'disconnect', reason: 'refresh_requested' });
        expect(sockets[0].closed).toBe(true);
        await vi.advanceTimersByTimeAsync(1000);
        expect(sockets.map(socket => socket.url)).toEqual(['wss://slack.example/1', 'wss://slack.example/2']);
        client.stop();
    });

    it('connects again after the socket closes, and not after stop', async () => {
        vi.useFakeTimers();
        const { client, sockets } = setup();
        client.start();
        await vi.advanceTimersByTimeAsync(0);
        sockets[0].close();
        await vi.advanceTimersByTimeAsync(1000);
        expect(sockets).toHaveLength(2);
        client.stop();
        expect(sockets[1].closed).toBe(true);
        await vi.advanceTimersByTimeAsync(5000);
        expect(sockets).toHaveLength(2);
    });

    it('stops after a token error and tries again after another error', async () => {
        vi.useFakeTimers();
        const fatal = setup(async () => {
            throw new SlackApiError('invalid_auth');
        });
        fatal.client.start();
        await vi.advanceTimersByTimeAsync(5000);
        expect(fatal.states.at(-1)).toMatchObject({ state: 'error' });
        expect(fatal.states.filter(item => item.state === 'connecting')).toHaveLength(1);

        let calls = 0;
        const flaky = setup(async () => {
            calls += 1;
            if (calls === 1) throw new Error('network down');
            return 'wss://slack.example/ok';
        });
        flaky.client.start();
        await vi.advanceTimersByTimeAsync(1000);
        expect(flaky.sockets.map(socket => socket.url)).toEqual(['wss://slack.example/ok']);
        flaky.client.stop();
    });

    it('stops with an error when Slack turns Socket Mode off', async () => {
        const { client, sockets, states } = setup();
        client.start();
        await flush();
        sockets[0].frame({ type: 'disconnect', reason: 'link_disabled' });
        expect(states.at(-1)).toMatchObject({ state: 'error' });
        expect(sockets[0].closed).toBe(true);
    });
});
