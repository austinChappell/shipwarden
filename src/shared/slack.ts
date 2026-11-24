/**
 * The Slack connection (Settings › Slack). A Slack app with Socket Mode connects ShipWarden to one channel:
 * - When an agent needs input, ShipWarden posts the question in a thread of the channel.
 * - A reply in that thread goes to the agent as input.
 * - A message that mentions the app starts an agent in a new worktree of a repository.
 * The tokens are in the macOS keychain. The settings file has only the values below.
 */

export interface SlackSettings {
    /** True when ShipWarden connects to Slack. Off by default. */
    enabled: boolean;
    /** The ID of the channel for the questions and the starts, for example "C0123ABCD". */
    channelId?: string;
    /** The name of the channel without "#", for the settings page. */
    channelName?: string;
    /**
     * The Slack member IDs (for example "U012AB3CD") that can start agents and answer agents. ShipWarden ignores the
     * other people in the channel. An empty list allows nobody.
     */
    allowedUserIds: string[];
}

export const DEFAULT_SLACK_SETTINGS: SlackSettings = { enabled: false, allowedUserIds: [] };

/** A Slack member ID. Slack IDs of people start with "U" or "W" (Enterprise Grid). */
const USER_ID = /^[UW][A-Z0-9]{2,20}$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{2,20}$/;

/** The member IDs in a text, in the order of the text and without duplicates. Separators: commas, spaces, and new lines. */
export function parseSlackUserIds(text: string): { ids: string[]; invalid: string[] } {
    const ids: string[] = [];
    const invalid: string[] = [];
    for (const word of text.split(/[\s,]+/)) {
        const value = word
            .trim()
            .replace(/^<@|>$/g, '')
            .toUpperCase();
        if (!value) continue;
        if (!USER_ID.test(value)) invalid.push(word.trim());
        else if (!ids.includes(value)) ids.push(value);
    }
    return { ids, invalid };
}

export function normalizeSlackSettings(raw: unknown): SlackSettings {
    const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const channelId = typeof value.channelId === 'string' && CHANNEL_ID.test(value.channelId) ? value.channelId : undefined;
    const channelName = channelId && typeof value.channelName === 'string' && value.channelName.trim() ? value.channelName.trim() : undefined;
    const ids = Array.isArray(value.allowedUserIds) ? value.allowedUserIds.filter((id): id is string => typeof id === 'string') : [];
    return {
        enabled: value.enabled === true,
        ...(channelId ? { channelId } : {}),
        ...(channelName ? { channelName } : {}),
        allowedUserIds: parseSlackUserIds(ids.join(' ')).ids
    };
}

/** True when a text has the form of a Slack bot token. */
export function isBotToken(value: string): boolean {
    return /^xoxb-[A-Za-z0-9-]{10,}$/.test(value);
}

/** True when a text has the form of a Slack app-level token. Socket Mode needs it. */
export function isAppToken(value: string): boolean {
    return /^xapp-[A-Za-z0-9-]{10,}$/.test(value);
}

/**
 * The state of the Slack connection in this process:
 * - off: the switch is off, or a token is missing.
 * - standby: the background helper runs the connection, or the window is closed.
 * - connecting, connected, error.
 */
export type SlackConnectionState = 'off' | 'standby' | 'connecting' | 'connected' | 'error';

export interface SlackStatus {
    /** True for each saved token. The page never gets the tokens. */
    tokens: { bot: boolean; app: boolean };
    state: SlackConnectionState;
    error?: string;
    /** The name of the Slack workspace. */
    team?: string;
    /** The name of the app in Slack, for example "shipwarden". */
    botName?: string;
}

/** A channel for the channel picker. */
export interface SlackChannel {
    id: string;
    name: string;
    isPrivate: boolean;
}

/** The tokens that the page sends. An empty or missing value keeps the saved token. */
export interface SlackTokenInput {
    bot?: string;
    app?: string;
}
