import type { AgentState, AgentWaitKind } from '@shared/agents';
import type { Project } from '@shared/projects';
import type { RemoteStartResult } from '@shared/remote';
import { repoDisplayName, type AppSettings } from '@shared/settings';
import type { SlackConnectionState, SlackStatus } from '@shared/slack';
import type { TerminalSession } from '@shared/terminal';
import { NEEDS_INPUT_DELAY_MS, worktreeLabel } from '../push/push-notifier';
import { JsonStore } from '../tasks/json-store';
import { SlackApi, SlackApiError } from './slack-api';
import {
    agentInput,
    deniedText,
    escapeSlack,
    needsInputText,
    parseStartMessage,
    slackAction,
    startedText,
    type NamedRepo,
    type SlackAction
} from './slack-messages';
import type { SlackTokens } from './slack-tokens';
import { FATAL_CODES, SocketModeClient, type SlackEventCallback, type SocketFactory } from './socket-mode';

/** The time between the text and Enter. Claude Code takes text and Enter in one chunk as a paste. */
const SUBMIT_DELAY_MS = 200;
/** The number of event IDs that the bridge keeps to ignore an event that Slack sends again. */
const SEEN_EVENTS = 200;
/** The thread file keeps the newest threads only. */
const MAX_THREADS = 500;
/** The wait before a new try when Slack did not answer at the start, for example while the Mac has no network. */
const START_RETRY_MS = 60_000;

/** A thread of an agent session. The key in the file is the timestamp of the first message of the thread. */
interface ThreadRecord {
    sessionId: string;
    channel: string;
    at: number;
}

export interface ThreadFile {
    threads: Record<string, ThreadRecord>;
}

/** The store of the thread file. `JsonStore` has this shape. The tests use a store in memory. */
export interface ThreadStore {
    get(): Promise<ThreadFile>;
    update(change: (value: ThreadFile) => ThreadFile): Promise<ThreadFile>;
    reload(): Promise<void>;
}

export interface SlackBridgeOptions {
    settings(): Promise<AppSettings>;
    tokens(): Promise<SlackTokens>;
    projects(): Promise<Project[]>;
    sessions(): Promise<TerminalSession[]>;
    /** Writes to the terminal of an agent session. */
    write(sessionId: string, data: string): void;
    /** Starts an agent in a new worktree, with the checks of a start from the phone (`RemoteStarter`). */
    start(request: { repoPath: string; prompt: string }): Promise<RemoteStartResult>;
    /** The file of the agent threads. The app and the helper share it, so a reply works after a handover. */
    threadsFile: string;
    /** Replaces the store of the thread file. */
    threadStore?: ThreadStore;
    api?: SlackApi;
    socket?: SocketFactory;
    log(message: string): void;
    /** Called after each change of the status. */
    onStatus?(status: SlackStatus): void;
    /** The time that an agent must wait before the post. */
    delayMs?: number;
    submitDelayMs?: number;
    now?(): number;
}

/** The connection while it runs. */
interface Connection {
    /** The tokens of the connection. A change of a token makes a new connection. */
    key: string;
    botToken: string;
    botUserId: string;
    client: SocketModeClient;
    /** The channel that the app joined. */
    joined?: string;
}

/** An agent that waits for input. "sent" after the post. */
interface Wait {
    timer?: ReturnType<typeof setTimeout>;
    waitFor?: AgentWaitKind;
    message?: string;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Connects ShipWarden to one Slack channel with Socket Mode:
 * - When an agent waits for input for 10 seconds, it posts the question. Each agent session has one thread.
 * - A reply in the thread of an agent goes to the agent.
 * - A mention of the app ("@ShipWarden <repository> <prompt>") starts an agent and answers in the thread.
 *
 * Only the process that holds the automation lock runs the connection (`setActive`): the app while a window is open,
 * else the background helper. So Slack gets each question one time only.
 */
export class SlackBridge {
    private readonly api: SlackApi;
    private readonly store: ThreadStore;
    private active = false;
    private connection: Connection | undefined;
    private state: SlackConnectionState = 'off';
    private error: string | undefined;
    private team: string | undefined;
    private botName: string | undefined;
    private tokensSaved = { bot: false, app: false };
    private readonly waits = new Map<string, Wait>();
    private readonly seen: string[] = [];
    /** The people who got the "not allowed" reply in a thread. They get it one time per thread. */
    private readonly denied = new Set<string>();
    private applying: Promise<void> = Promise.resolve();
    private retryTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly options: SlackBridgeOptions) {
        this.api = options.api ?? new SlackApi();
        this.store = options.threadStore ?? new JsonStore<ThreadFile>(options.threadsFile, () => ({ threads: {} }));
    }

    status(): SlackStatus {
        return {
            tokens: { ...this.tokensSaved },
            state: this.state,
            ...(this.error ? { error: this.error } : {}),
            ...(this.team ? { team: this.team } : {}),
            ...(this.botName ? { botName: this.botName } : {})
        };
    }

    /** Tells the bridge whether this process holds the automation lock. The other process can change the thread file, so it loads again. */
    async setActive(active: boolean): Promise<void> {
        if (active && !this.active) await this.store.reload();
        this.active = active;
        await this.apply();
    }

    /** Reads the settings and the tokens again, then connects, connects again, or disconnects. The calls run one at a time. */
    apply(): Promise<void> {
        this.applying = this.applying.then(
            () => this.applyOnce(),
            () => this.applyOnce()
        );
        return this.applying;
    }

    async stop(): Promise<void> {
        this.active = false;
        await this.apply();
    }

    /** The public channels and the private channels of the app, for the channel picker. */
    async channels() {
        const { bot } = await this.options.tokens();
        if (!bot) throw new Error('Save the bot token first.');
        return (await this.api.channels(bot)).sort((a, b) => a.name.localeCompare(b.name));
    }

    /** Gives a new state of an agent session. A wait of 10 seconds posts the question. */
    agentState(sessionId: string, update: { state: AgentState; waitFor?: AgentWaitKind; message?: string }): void {
        if (update.state !== 'waiting') {
            this.forget(sessionId);
            return;
        }
        const current = this.waits.get(sessionId);
        if (current) {
            if (current.timer) {
                current.waitFor = update.waitFor ?? current.waitFor;
                current.message = update.message ?? current.message;
            }
            return;
        }
        if (!this.connection) return;
        const wait: Wait = { waitFor: update.waitFor, message: update.message };
        wait.timer = setTimeout(() => {
            wait.timer = undefined;
            void this.postQuestion(sessionId, wait).catch(error => this.options.log(`The question did not go to Slack: ${errorText(error)}`));
        }, this.options.delayMs ?? NEEDS_INPUT_DELAY_MS);
        this.waits.set(sessionId, wait);
    }

    /** Ends the wait of a session, for example when its terminal closes. */
    forget(sessionId: string): void {
        const wait = this.waits.get(sessionId);
        if (wait?.timer) clearTimeout(wait.timer);
        this.waits.delete(sessionId);
    }

    private setState(state: SlackConnectionState, error?: string): void {
        this.state = state;
        this.error = error;
        this.options.onStatus?.(this.status());
    }

    private async applyOnce(): Promise<void> {
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        let settings: AppSettings;
        let tokens: SlackTokens;
        try {
            [settings, tokens] = await Promise.all([this.options.settings(), this.options.tokens()]);
        } catch (error) {
            this.disconnect();
            this.setState('error', errorText(error));
            return;
        }
        this.tokensSaved = { bot: !!tokens.bot, app: !!tokens.app };
        const slack = settings.slack;
        if (!slack.enabled || !tokens.bot || !tokens.app) {
            this.disconnect();
            this.setState('off');
            return;
        }
        if (!this.active) {
            this.disconnect();
            this.setState('standby');
            return;
        }
        const key = `${tokens.bot}\n${tokens.app}`;
        if (this.connection?.key !== key) {
            this.disconnect();
            await this.connect(key, tokens.bot, tokens.app);
        }
        if (this.connection) await this.joinChannel(this.connection, slack.channelId);
    }

    private async connect(key: string, botToken: string, appToken: string): Promise<void> {
        this.setState('connecting');
        let identity: Awaited<ReturnType<SlackApi['identity']>>;
        try {
            identity = await this.api.identity(botToken);
        } catch (error) {
            this.setState('error', errorText(error));
            // A wrong token does not start to work by itself. A network error can go away.
            const code = error instanceof SlackApiError ? error.code : undefined;
            if (!code || !FATAL_CODES.has(code)) this.retryTimer = setTimeout(() => void this.apply(), START_RETRY_MS);
            return;
        }
        this.team = identity.team || undefined;
        this.botName = identity.user;
        const client = new SocketModeClient({
            openUrl: () => this.api.socketUrl(appToken),
            socket: this.options.socket,
            onEvent: payload => void this.onEvent(payload).catch(error => this.options.log(`A Slack event failed: ${errorText(error)}`)),
            onState: (state, error) => {
                if (this.connection?.client === client) this.setState(state, error);
            },
            log: message => this.options.log(message)
        });
        this.connection = { key, botToken, botUserId: identity.userId, client };
        client.start();
    }

    private disconnect(): void {
        const connection = this.connection;
        this.connection = undefined;
        connection?.client.stop();
        for (const id of [...this.waits.keys()]) this.forget(id);
    }

    /** Joins the channel of the settings one time. A private channel needs an invite, so its error shows in the status. */
    private async joinChannel(connection: Connection, channel: string | undefined): Promise<void> {
        if (!channel || connection.joined === channel) return;
        try {
            await this.api.join(connection.botToken, channel);
            connection.joined = channel;
        } catch (error) {
            const code = error instanceof SlackApiError ? error.code : undefined;
            if (code === 'method_not_supported_for_channel_type' || code === 'already_in_channel') {
                connection.joined = channel;
                return;
            }
            this.options.log(`The app did not join the channel: ${errorText(error)}`);
            if (this.connection === connection) {
                this.error = errorText(error);
                this.options.onStatus?.(this.status());
            }
        }
    }

    private async threadOfSession(sessionId: string, channel: string): Promise<string | undefined> {
        const { threads } = await this.store.get();
        let found: { ts: string; at: number } | undefined;
        for (const [ts, record] of Object.entries(threads)) {
            if (record.sessionId === sessionId && record.channel === channel && (!found || record.at > found.at)) found = { ts, at: record.at };
        }
        return found?.ts;
    }

    private async saveThread(ts: string, sessionId: string, channel: string): Promise<void> {
        const at = this.options.now?.() ?? Date.now();
        await this.store.update(file => {
            const entries = Object.entries({ ...file.threads, [ts]: { sessionId, channel, at } })
                .sort(([, a], [, b]) => b.at - a.at)
                .slice(0, MAX_THREADS);
            return { threads: Object.fromEntries(entries) };
        });
    }

    private async postQuestion(sessionId: string, wait: Wait): Promise<void> {
        const connection = this.connection;
        const channel = (await this.options.settings()).slack.channelId;
        if (!connection || !channel || this.waits.get(sessionId) !== wait) return;
        const session = (await this.options.sessions()).find(item => item.id === sessionId);
        if (!session || session.exited) return;
        const text = needsInputText({
            worktree: worktreeLabel(session.worktreePath),
            agent: session.title,
            waitFor: wait.waitFor,
            message: wait.message
        });
        const thread = await this.threadOfSession(sessionId, channel);
        const posted = await this.api.post(connection.botToken, channel, text, thread);
        if (!thread && posted.ts) await this.saveThread(posted.ts, sessionId, channel);
    }

    private async onEvent(payload: SlackEventCallback): Promise<void> {
        const event = payload.event;
        if (!event) return;
        if (payload.event_id) {
            if (this.seen.includes(payload.event_id)) return;
            this.seen.push(payload.event_id);
            if (this.seen.length > SEEN_EVENTS) this.seen.shift();
        }
        const connection = this.connection;
        if (!connection) return;
        const settings = await this.options.settings();
        const channelId = settings.slack.channelId;
        if (!channelId) return;
        const { threads } = await this.store.get();
        const action = slackAction(event, {
            botUserId: connection.botUserId,
            channelId,
            allowedUserIds: settings.slack.allowedUserIds,
            sessionOfThread: ts => (threads[ts]?.channel === channelId ? threads[ts].sessionId : undefined)
        });
        await this.run(action, connection, channelId, settings);
    }

    private async run(action: SlackAction, connection: Connection, channel: string, settings: AppSettings): Promise<void> {
        const reply = (text: string, threadTs: string) => this.api.post(connection.botToken, channel, text, threadTs);
        switch (action.kind) {
            case 'ignore':
                return;
            case 'denied': {
                const key = `${action.threadTs}:${action.user}`;
                if (this.denied.has(key)) return;
                if (this.denied.size >= SEEN_EVENTS) this.denied.clear();
                this.denied.add(key);
                this.options.log(`Slack user ${action.user} is not on the allow list.`);
                await reply(deniedText(action.user), action.threadTs);
                return;
            }
            case 'reply': {
                const session = (await this.options.sessions()).find(item => item.id === action.sessionId);
                if (!session || session.exited) {
                    await reply('The agent tab closed, so ShipWarden cannot send the reply.', action.threadTs);
                    return;
                }
                const input = agentInput(action.text);
                this.options.write(action.sessionId, input.data);
                if (input.submit) {
                    await delay(this.options.submitDelayMs ?? SUBMIT_DELAY_MS);
                    this.options.write(action.sessionId, '\r');
                }
                // The answer ends the wait. The next wait posts again.
                this.forget(action.sessionId);
                await this.api.react(connection.botToken, channel, action.ts, 'white_check_mark').catch(() => undefined);
                return;
            }
            case 'start': {
                const repos = await this.namedRepos(settings);
                const parsed = parseStartMessage(action.text, connection.botUserId, repos);
                if (parsed.kind === 'help') {
                    await reply(parsed.text, action.threadTs);
                    return;
                }
                let result: RemoteStartResult;
                try {
                    result = await this.options.start({ repoPath: parsed.repoPath, prompt: parsed.prompt });
                } catch (error) {
                    await reply(`:warning: The agent did not start. ${escapeSlack(errorText(error))}`, action.threadTs);
                    return;
                }
                await this.saveThread(action.threadTs, result.agent.id, channel);
                await reply(
                    startedText({ agent: result.agent.title, worktree: result.worktree.name, repo: repoDisplayName(settings, parsed.repoPath) }),
                    action.threadTs
                );
                return;
            }
        }
    }

    private async namedRepos(settings: AppSettings): Promise<NamedRepo[]> {
        const paths = [...new Set((await this.options.projects()).flatMap(project => project.repos))];
        return paths.map(path => ({ path, name: repoDisplayName(settings, path) }));
    }
}
