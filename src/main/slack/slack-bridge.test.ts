import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteStartResult } from '@shared/remote';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings';
import type { SlackStatus } from '@shared/slack';
import type { TerminalSession } from '@shared/terminal';
import { SlackApi, SlackApiError } from './slack-api';
import { SlackBridge, type ThreadFile, type ThreadStore } from './slack-bridge';
import type { SlackTokens } from './slack-tokens';
import type { SocketLike } from './socket-mode';

const BOT = 'UBOT';

class FakeSocket implements SocketLike {
    readonly sent: string[] = [];
    private readonly listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
    send(data: string): void {
        this.sent.push(data);
    }
    close(): void {
        for (const listener of this.listeners.get('close') ?? []) listener({ data: undefined });
    }
    addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    frame(value: unknown): void {
        for (const listener of this.listeners.get('message') ?? []) listener({ data: JSON.stringify(value) });
    }
}

/** A fake Web API: it records the posts and the reactions. */
class FakeApi extends SlackApi {
    posts: { channel: string; text: string; threadTs?: string }[] = [];
    reactions: string[] = [];
    joined: string[] = [];
    joinError: string | undefined;
    identityErrors: Error[] = [];
    private next = 100;

    override async identity() {
        const error = this.identityErrors.shift();
        if (error) throw error;
        return { userId: BOT, user: 'shipwarden', team: 'Acme' };
    }
    override async socketUrl() {
        return 'wss://slack.example/socket';
    }
    override async post(_token: string, channel: string, text: string, threadTs?: string) {
        this.posts.push({ channel, text, ...(threadTs ? { threadTs } : {}) });
        return { channel, ts: `${this.next++}.0` };
    }
    override async react(_token: string, _channel: string, ts: string, name: string) {
        this.reactions.push(`${ts}:${name}`);
    }
    override async join(_token: string, channel: string) {
        if (this.joinError) throw new SlackApiError(this.joinError);
        this.joined.push(channel);
    }
}

const session = (id: string, change: Partial<TerminalSession> = {}): TerminalSession =>
    ({ id, title: 'Claude Code', cwd: '/wt/fix-login', worktreePath: '/wt/fix-login', isAgent: true, exited: false, ...change }) as TerminalSession;

afterEach(() => {
    vi.useRealTimers();
});

/** A thread store in memory. */
function memoryStore(): ThreadStore & { value: ThreadFile } {
    const store = {
        value: { threads: {} } as ThreadFile,
        get: async () => store.value,
        update: async (change: (value: ThreadFile) => ThreadFile) => {
            store.value = change(store.value);
            return store.value;
        },
        reload: async () => undefined
    };
    return store;
}

function setup(change: { slack?: Partial<AppSettings['slack']>; tokens?: SlackTokens; start?: () => Promise<RemoteStartResult> } = {}) {
    const api = new FakeApi();
    const sockets: FakeSocket[] = [];
    const written: string[] = [];
    const statuses: SlackStatus[] = [];
    const sessions = [session('s1')];
    const settings: AppSettings = {
        ...DEFAULT_SETTINGS,
        slack: { enabled: true, channelId: 'C1', channelName: 'agents', allowedUserIds: ['UALICE'], ...change.slack }
    };
    const starts: { repoPath: string; prompt: string }[] = [];
    const threads = memoryStore();
    const bridge = new SlackBridge({
        settings: async () => settings,
        tokens: async () => change.tokens ?? { bot: 'xoxb-1', app: 'xapp-1' },
        projects: async () => [{ id: 'p', name: 'P', repos: ['/code/web'] } as never],
        sessions: async () => sessions,
        write: (id, data) => written.push(`${id}:${data}`),
        start: async request => {
            starts.push(request);
            if (change.start) return change.start();
            return {
                repoPath: request.repoPath,
                worktree: { path: '/wt/fix-bug', name: 'fix-bug', isMain: false },
                agent: { id: 's9', title: 'Claude Code', worktreePath: '/wt/fix-bug', cwd: '/wt/fix-bug', state: 'starting', exited: false }
            } as RemoteStartResult;
        },
        threadsFile: '/unused/slack-threads.json',
        threadStore: threads,
        api,
        socket: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
        },
        log: () => undefined,
        onStatus: status => statuses.push(status),
        delayMs: 10_000,
        submitDelayMs: 0
    });
    /** Sends an event in an envelope, as Slack does. */
    const event = (event: Record<string, unknown>, id = `Ev${Math.random()}`) =>
        sockets.at(-1)?.frame({ envelope_id: `env-${id}`, type: 'events_api', payload: { event_id: id, event } });
    return { bridge, api, sockets, written, statuses, sessions, starts, threads, event };
}

const settle = async () => {
    for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve));
};

describe('SlackBridge', () => {
    it('stays off without the switch or a token, and waits while the process does not hold the lock', async () => {
        const off = setup({ slack: { enabled: false } });
        await off.bridge.setActive(true);
        expect(off.bridge.status()).toEqual({ tokens: { bot: true, app: true }, state: 'off' });

        const noToken = setup({ tokens: { bot: 'xoxb-1' } });
        await noToken.bridge.setActive(true);
        expect(noToken.bridge.status()).toMatchObject({ tokens: { bot: true, app: false }, state: 'off' });

        const standby = setup();
        await standby.bridge.apply();
        expect(standby.bridge.status().state).toBe('standby');
        expect(standby.sockets).toHaveLength(0);
    });

    it('connects while active, joins the channel, and disconnects when the lock goes away', async () => {
        const { bridge, api, sockets } = setup();
        await bridge.setActive(true);
        await settle();
        expect(sockets).toHaveLength(1);
        expect(api.joined).toEqual(['C1']);
        sockets[0].frame({ type: 'hello' });
        expect(bridge.status()).toEqual({ tokens: { bot: true, app: true }, state: 'connected', team: 'Acme', botName: 'shipwarden' });
        await bridge.setActive(false);
        expect(bridge.status().state).toBe('standby');
    });

    it('tries again a minute after a network error at the start, and not after a token error', async () => {
        vi.useFakeTimers();
        const network = setup();
        network.api.identityErrors = [new Error('fetch failed')];
        await network.bridge.setActive(true);
        expect(network.bridge.status()).toMatchObject({ state: 'error', error: 'fetch failed' });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(network.sockets).toHaveLength(1);

        const token = setup();
        token.api.identityErrors = [new SlackApiError('invalid_auth')];
        await token.bridge.setActive(true);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(token.sockets).toHaveLength(0);
        expect(token.bridge.status().state).toBe('error');
    });

    it('shows the error of a private channel that the app is not in', async () => {
        const { bridge, api } = setup();
        api.joinError = 'channel_not_found';
        await bridge.setActive(true);
        expect(bridge.status().error).toContain('cannot find the channel');
    });

    it('posts the question after 10 seconds of wait, and the next question in the same thread', async () => {
        vi.useFakeTimers();
        const { bridge, api, threads } = setup();
        await bridge.setActive(true);
        bridge.agentState('s1', { state: 'waiting', waitFor: 'permission', message: 'Run npm test?' });
        await vi.advanceTimersByTimeAsync(9_000);
        expect(api.posts).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(api.posts).toHaveLength(1);
        expect(api.posts[0]).toMatchObject({ channel: 'C1' });
        expect(api.posts[0].text).toContain('*fix-login* (Claude Code) is asking for permission');
        expect(api.posts[0].text).toContain('> Run npm test?');

        // A second "waiting" state of the same wait posts nothing.
        bridge.agentState('s1', { state: 'waiting' });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(api.posts).toHaveLength(1);

        bridge.agentState('s1', { state: 'working' });
        bridge.agentState('s1', { state: 'waiting', waitFor: 'question', message: 'Which branch?' });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(api.posts[1]).toMatchObject({ threadTs: '100.0' });
        expect(threads.value.threads['100.0']).toMatchObject({ sessionId: 's1', channel: 'C1' });
    });

    it('posts nothing when the agent continues in time', async () => {
        vi.useFakeTimers();
        const { bridge, api } = setup();
        await bridge.setActive(true);
        bridge.agentState('s1', { state: 'waiting' });
        await vi.advanceTimersByTimeAsync(5_000);
        bridge.agentState('s1', { state: 'working' });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(api.posts).toHaveLength(0);
    });

    it('sends a reply in the thread to the agent and adds a check mark', async () => {
        vi.useFakeTimers();
        const { bridge, api, written, event } = setup();
        await bridge.setActive(true);
        bridge.agentState('s1', { state: 'waiting' });
        await vi.advanceTimersByTimeAsync(10_000);
        event({ type: 'message', channel: 'C1', user: 'UALICE', text: 'Use main', ts: '200.0', thread_ts: '100.0' });
        await vi.advanceTimersByTimeAsync(10);
        expect(written).toEqual(['s1:\x1b[200~Use main\x1b[201~', 's1:\r']);
        expect(api.reactions).toEqual(['200.0:white_check_mark']);

        // Slack sends an event again when the acknowledgement was late. The bridge uses it one time only.
        event({ type: 'message', channel: 'C1', user: 'UALICE', text: '1', ts: '201.0', thread_ts: '100.0' }, 'Ev-same');
        event({ type: 'message', channel: 'C1', user: 'UALICE', text: '1', ts: '201.0', thread_ts: '100.0' }, 'Ev-same');
        await vi.advanceTimersByTimeAsync(10);
        expect(written.slice(2)).toEqual(['s1:1']);
    });

    it('tells a person who is not on the allow list their member ID one time per thread', async () => {
        vi.useFakeTimers();
        const { bridge, api, written, event } = setup();
        await bridge.setActive(true);
        bridge.agentState('s1', { state: 'waiting' });
        await vi.advanceTimersByTimeAsync(10_000);
        event({ type: 'message', channel: 'C1', user: 'UBOB', text: 'yes', ts: '200.0', thread_ts: '100.0' });
        event({ type: 'message', channel: 'C1', user: 'UBOB', text: 'yes!', ts: '201.0', thread_ts: '100.0' });
        await vi.advanceTimersByTimeAsync(10);
        expect(written).toEqual([]);
        expect(api.posts.slice(1)).toHaveLength(1);
        expect(api.posts[1]).toMatchObject({ threadTs: '100.0' });
        expect(api.posts[1].text).toContain('`UBOB`');
    });

    it('starts an agent for a mention, answers in the thread, and links the thread to the agent', async () => {
        const { bridge, api, starts, event, sessions, written } = setup();
        await bridge.setActive(true);
        event({ type: 'app_mention', channel: 'C1', user: 'UALICE', text: `<@${BOT}> web Fix the bug`, ts: '300.0' });
        await settle();
        expect(starts).toEqual([{ repoPath: '/code/web', prompt: 'Fix the bug' }]);
        expect(api.posts).toEqual([
            {
                channel: 'C1',
                threadTs: '300.0',
                text: ':rocket: Claude Code is working in *fix-bug* (web). ShipWarden posts its questions in this thread. Reply here to answer them.'
            }
        ]);
        // A reply in the thread goes to the new agent.
        sessions.push(session('s9', { worktreePath: '/wt/fix-bug' }));
        event({ type: 'message', channel: 'C1', user: 'UALICE', text: '2', ts: '301.0', thread_ts: '300.0' });
        await settle();
        expect(written).toEqual(['s9:2']);
    });

    it('answers with help for an unknown repository, and with the error of a failed start', async () => {
        const help = setup();
        await help.bridge.setActive(true);
        help.event({ type: 'app_mention', channel: 'C1', user: 'UALICE', text: `<@${BOT}> mobile Fix it`, ts: '1.0' });
        await settle();
        expect(help.starts).toEqual([]);
        expect(help.api.posts[0].text).toContain('Repositories: `web`.');

        const failed = setup({
            start: async () => {
                throw new Error('The usage budget is at 90 %.');
            }
        });
        await failed.bridge.setActive(true);
        failed.event({ type: 'app_mention', channel: 'C1', user: 'UALICE', text: `<@${BOT}> web Fix it`, ts: '1.0' });
        await settle();
        expect(failed.api.posts[0]).toEqual({ channel: 'C1', threadTs: '1.0', text: ':warning: The agent did not start. The usage budget is at 90 %.' });
    });

    it('tells the thread when the agent tab closed', async () => {
        vi.useFakeTimers();
        const { bridge, api, sessions, written, event } = setup();
        await bridge.setActive(true);
        bridge.agentState('s1', { state: 'waiting' });
        await vi.advanceTimersByTimeAsync(10_000);
        sessions[0] = session('s1', { exited: true });
        event({ type: 'message', channel: 'C1', user: 'UALICE', text: 'go', ts: '200.0', thread_ts: '100.0' });
        await vi.advanceTimersByTimeAsync(10);
        expect(written).toEqual([]);
        expect(api.posts[1].text).toContain('agent tab closed');
    });
});
