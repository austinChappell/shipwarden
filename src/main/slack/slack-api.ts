import type { SlackChannel } from '@shared/slack';

/** The Slack Web API. */
const API_URL = 'https://slack.com/api/';
const TIMEOUT_MS = 15_000;
/** The most pages of the channel list. Each page has up to 200 channels. */
const MAX_CHANNEL_PAGES = 5;

/** An error answer of the Slack Web API, for example "invalid_auth" or "channel_not_found". */
export class SlackApiError extends Error {
    constructor(
        readonly code: string,
        message?: string
    ) {
        super(message ?? slackErrorText(code));
        this.name = 'SlackApiError';
    }
}

/** A text for people for the error codes that the settings page shows. */
export function slackErrorText(code: string): string {
    switch (code) {
        case 'invalid_auth':
        case 'not_authed':
        case 'token_revoked':
        case 'account_inactive':
            return 'Slack does not accept the token. Copy the token from the Slack app page again.';
        case 'not_allowed_token_type':
            return 'The token has the wrong type. The bot token starts with "xoxb-", and the app-level token starts with "xapp-".';
        case 'missing_scope':
            return 'The Slack app does not have all scopes. Create the app again from the manifest in docs/slack.md, or add the missing scopes.';
        case 'channel_not_found':
            return 'Slack cannot find the channel. Select the channel again.';
        case 'not_in_channel':
            return 'The app is not in the channel. Invite it with /invite @ShipWarden.';
        case 'method_not_supported_for_channel_type':
            return 'The app cannot join a private channel. Invite it with /invite @ShipWarden.';
        case 'ratelimited':
            return 'Slack limits the requests now. ShipWarden tries again in a few seconds.';
        default:
            return `Slack answered with the error "${code}".`;
    }
}

/** The values of a Web API call. Slack accepts form values for each method. */
type Params = Record<string, string | number | boolean | undefined>;

export interface SlackApiOptions {
    /** Resolves when the trusted certificates of Settings › Network apply. */
    ready?: Promise<void>;
    fetch?: typeof fetch;
}

export interface SlackIdentity {
    userId: string;
    user: string;
    team: string;
}

export interface PostedMessage {
    channel: string;
    ts: string;
}

/**
 * A small client of the Slack Web API with `fetch`. The requests use the trusted certificates of Settings › Network,
 * because `fetch` uses the default CA certificates of the process.
 */
export class SlackApi {
    constructor(private readonly options: SlackApiOptions = {}) {}

    /** Calls a Web API method. Throws a `SlackApiError` when Slack answers `ok: false`. */
    async call<T extends object>(method: string, token: string, params: Params = {}): Promise<T> {
        await this.options.ready;
        const body = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined) body.set(key, String(value));
        }
        const response = await (this.options.fetch ?? fetch)(`${API_URL}${method}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
            body: body.toString(),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        if (response.status === 429) throw new SlackApiError('ratelimited');
        if (!response.ok) throw new SlackApiError(`http_${response.status}`, `Slack answered with HTTP ${response.status}.`);
        const data = (await response.json()) as { ok?: boolean; error?: string; needed?: string } & T;
        if (!data.ok) {
            const code = data.error ?? 'unknown_error';
            const error = new SlackApiError(code);
            if (code === 'missing_scope' && data.needed) error.message = `${error.message} Missing: ${data.needed}.`;
            throw error;
        }
        return data;
    }

    /** The bot user and the workspace of a bot token. */
    async identity(botToken: string): Promise<SlackIdentity> {
        const data = await this.call<{ user_id?: string; user?: string; team?: string }>('auth.test', botToken);
        if (!data.user_id) throw new SlackApiError('invalid_auth');
        return { userId: data.user_id, user: data.user ?? 'shipwarden', team: data.team ?? '' };
    }

    /** A new Socket Mode address. Each address works for one connection. */
    async socketUrl(appToken: string): Promise<string> {
        const data = await this.call<{ url?: string }>('apps.connections.open', appToken);
        if (!data.url) throw new SlackApiError('no_socket_url', 'Slack did not send a Socket Mode address.');
        return data.url;
    }

    /** Posts a message. With `threadTs`, the message goes in that thread. */
    async post(botToken: string, channel: string, text: string, threadTs?: string): Promise<PostedMessage> {
        const data = await this.call<{ channel?: string; ts?: string }>('chat.postMessage', botToken, {
            channel,
            text,
            thread_ts: threadTs,
            unfurl_links: false,
            unfurl_media: false
        });
        return { channel: data.channel ?? channel, ts: data.ts ?? '' };
    }

    /** Adds an emoji reaction to a message. */
    async react(botToken: string, channel: string, ts: string, name: string): Promise<void> {
        await this.call('reactions.add', botToken, { channel, timestamp: ts, name });
    }

    /** Joins a public channel. A private channel needs an invite. */
    async join(botToken: string, channel: string): Promise<void> {
        await this.call('conversations.join', botToken, { channel });
    }

    /** The public channels, and the private channels that the app is in. Archived channels do not show. */
    async channels(botToken: string): Promise<SlackChannel[]> {
        const channels: SlackChannel[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_CHANNEL_PAGES; page++) {
            const data = await this.call<{
                channels?: { id: string; name: string; is_private?: boolean }[];
                response_metadata?: { next_cursor?: string };
            }>('conversations.list', botToken, { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor });
            for (const channel of data.channels ?? []) channels.push({ id: channel.id, name: channel.name, isPrivate: channel.is_private === true });
            cursor = data.response_metadata?.next_cursor || undefined;
            if (!cursor) break;
        }
        return channels;
    }
}
