import { basename } from 'path';
import type { AgentWaitKind } from '@shared/agents';
import { bracketedPaste } from '@shared/agent-text';
import type { SlackEvent } from './socket-mode';

/** The longest question text in a post. Slack accepts much more, but a long post is hard to read in a thread. */
const MAX_QUESTION_LENGTH = 2500;

/** Escapes the three characters that Slack reads as markup. */
export function escapeSlack(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Converts the markup of a Slack message to plain text for an agent:
 * - "<https://a.b|label>" and "<https://a.b>" become the address.
 * - "<#C123|name>" becomes "#name", and "<@U123>" becomes "@U123".
 * - "&amp;", "&lt;", and "&gt;" become "&", "<", and ">".
 */
export function slackPlainText(text: string): string {
    return text
        .replace(/<([^<>]+)>/g, (_match, inner: string) => {
            const [target, label] = inner.split('|', 2);
            if (target.startsWith('#')) return label ? `#${label}` : target;
            if (target.startsWith('@')) return target;
            if (target.startsWith('!')) return label ?? `@${target.slice(1)}`;
            return target;
        })
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim();
}

/** Removes each mention of the app ("<@U123>" with the ID of the bot user) from a message. */
export function withoutMention(text: string, botUserId: string): string {
    return text
        .replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, 'g'), ' ')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

/** A repository that a message can name. */
export interface NamedRepo {
    path: string;
    /** The display name of the repository in ShipWarden. */
    name: string;
}

export type StartParse = { kind: 'start'; repoPath: string; prompt: string } | { kind: 'help'; text: string };

/** The help text for a mention that ShipWarden cannot use. */
export function startHelp(reason: string, repos: readonly NamedRepo[]): string {
    const names = repos.map(repo => `\`${repoWord(repo)}\``);
    const list = names.length > 0 ? `\nRepositories: ${names.join(', ')}.` : '\nShipWarden has no repositories. Add a repository to a project first.';
    return `${reason}\nWrite the repository first, then the prompt. Example: \`@ShipWarden ${repos[0] ? repoWord(repos[0]) : 'my-repo'} Fix the login bug\`.${list}`;
}

/** The word that names a repository in a message: its folder name. */
export function repoWord(repo: NamedRepo): string {
    return basename(repo.path);
}

/**
 * Reads a message that mentions the app: "@ShipWarden <repository> <prompt>". The repository is the first word after
 * the mention. It is the folder name of the repository or its display name in ShipWarden, without regard to case.
 * A ":" after the name is allowed ("@ShipWarden web: Fix the login bug"). All text after the name is the prompt.
 */
export function parseStartMessage(text: string, botUserId: string, repos: readonly NamedRepo[]): StartParse {
    const plain = slackPlainText(withoutMention(text, botUserId));
    const match = /^(\S+?):?(?:\s+([\s\S]*))?$/.exec(plain);
    if (!match) return { kind: 'help', text: startHelp('The message has no repository and no prompt.', repos) };
    const word = match[1].toLowerCase();
    const prompt = (match[2] ?? '').trim();
    const found = repos.filter(repo => repoWord(repo).toLowerCase() === word || repo.name.toLowerCase() === word);
    if (found.length === 0) return { kind: 'help', text: startHelp(`ShipWarden has no repository with the name "${match[1]}".`, repos) };
    if (found.length > 1) {
        return { kind: 'help', text: startHelp(`More than one repository has the name "${match[1]}". Use a different name in Settings.`, repos) };
    }
    if (!prompt) return { kind: 'help', text: startHelp('The message has no prompt.', repos) };
    return { kind: 'start', repoPath: found[0].path, prompt };
}

/** What ShipWarden does with a Slack event. */
export type SlackAction =
    | { kind: 'ignore' }
    /** A reply in the thread of an agent. The text goes to the agent. */
    | { kind: 'reply'; sessionId: string; text: string; user: string; ts: string; threadTs: string }
    /** A mention of the app outside an agent thread. It starts an agent. */
    | { kind: 'start'; text: string; user: string; ts: string; threadTs: string }
    /** A person who is not on the allow list wrote to the app. */
    | { kind: 'denied'; user: string; ts: string; threadTs: string };

export interface EventContext {
    /** The user ID of the app in Slack. */
    botUserId: string;
    /** The channel of Settings › Slack. ShipWarden ignores the other channels. */
    channelId: string;
    allowedUserIds: readonly string[];
    /** The agent session of a thread, by the timestamp of the first message of the thread. */
    sessionOfThread(threadTs: string): string | undefined;
}

/**
 * Maps a Slack event to an action. Slack sends two events for a mention: "app_mention" and "message". This function
 * uses the "message" event for a reply in an agent thread, and the "app_mention" event for a start. So each message
 * gives one action only.
 */
export function slackAction(event: SlackEvent, context: EventContext): SlackAction {
    if (event.channel !== context.channelId || !event.user || !event.ts) return { kind: 'ignore' };
    // Messages of bots (also of this app), edits, and deletes have a subtype or a bot ID.
    if (event.subtype || event.bot_id || event.user === context.botUserId) return { kind: 'ignore' };
    const allowed = context.allowedUserIds.includes(event.user);
    const threadTs = event.thread_ts;
    const threadSession = threadTs && threadTs !== event.ts ? context.sessionOfThread(threadTs) : undefined;

    if (event.type === 'message') {
        if (!threadTs || !threadSession) return { kind: 'ignore' };
        if (!allowed) return { kind: 'denied', user: event.user, ts: event.ts, threadTs };
        const text = slackPlainText(withoutMention(event.text ?? '', context.botUserId));
        if (!text) return { kind: 'ignore' };
        return { kind: 'reply', sessionId: threadSession, text, user: event.user, ts: event.ts, threadTs };
    }
    if (event.type === 'app_mention') {
        // The "message" event of the same message is the reply.
        if (threadSession) return { kind: 'ignore' };
        const thread = threadTs ?? event.ts;
        if (!allowed) return { kind: 'denied', user: event.user, ts: event.ts, threadTs: thread };
        return { kind: 'start', text: event.text ?? '', user: event.user, ts: event.ts, threadTs: thread };
    }
    return { kind: 'ignore' };
}

/** The text that a reply in a thread sends to the terminal of the agent. */
export interface AgentInput {
    /** The text, written at once. */
    data: string;
    /** True when Enter must follow after a short wait. Claude Code takes text and Enter in one chunk as a paste. */
    submit: boolean;
}

/**
 * Converts a reply to the input of an agent. A reply with one digit selects that option of a permission request or a
 * question menu, as a key press. Other text goes in as a paste, followed by Enter.
 */
export function agentInput(reply: string): AgentInput {
    const text = reply.trim();
    if (/^[1-9]$/.test(text)) return { data: text, submit: false };
    return { data: bracketedPaste(text), submit: true };
}

/** The text of the post when an agent needs input. */
export function needsInputText(input: { worktree?: string; agent?: string; waitFor?: AgentWaitKind; message?: string }): string {
    const where = input.worktree ? `*${escapeSlack(input.worktree)}*` : 'An agent';
    const who = input.agent ? ` (${escapeSlack(input.agent)})` : '';
    const what = input.waitFor === 'permission' ? 'is asking for permission' : input.waitFor === 'question' ? 'is asking a question' : 'is waiting for input';
    const lines = [`:raising_hand: ${where}${who} ${what}.`];
    const message = input.message?.trim();
    if (message) {
        const short = message.length > MAX_QUESTION_LENGTH ? `${message.slice(0, MAX_QUESTION_LENGTH - 1).trimEnd()}…` : message;
        lines.push(
            escapeSlack(short)
                .split('\n')
                .map(line => `> ${line}`)
                .join('\n')
        );
    }
    lines.push(
        input.waitFor === 'permission' || input.waitFor === 'question'
            ? '_Reply in this thread to answer. Reply with a number to select that option._'
            : '_Reply in this thread to send the text to the agent._'
    );
    return lines.join('\n');
}

/** The reply after a start. */
export function startedText(result: { agent: string; worktree: string; repo: string }): string {
    return `:rocket: ${escapeSlack(result.agent)} is working in *${escapeSlack(result.worktree)}* (${escapeSlack(result.repo)}). ShipWarden posts its questions in this thread. Reply here to answer them.`;
}

/** The reply to a person who is not on the allow list. It gives the member ID, so the owner of the Mac can add it. */
export function deniedText(user: string): string {
    return `ShipWarden does not accept requests from <@${user}>. To allow them, add the member ID \`${user}\` in Settings › Slack on the Mac.`;
}
