import { describe, expect, it } from 'vitest';
import { agentInput, deniedText, needsInputText, parseStartMessage, slackAction, slackPlainText, withoutMention, type EventContext } from './slack-messages';
import type { SlackEvent } from './socket-mode';

const BOT = 'UBOT1';
const REPOS = [
    { path: '/code/web', name: 'web' },
    { path: '/code/api-server', name: 'Backend' }
];

describe('slackPlainText', () => {
    it('converts links, channels, mentions, and entities', () => {
        expect(slackPlainText('See <https://a.example/x|the doc> &amp; <https://b.example> in <#C123|general> for <@U999> &lt;3 &gt;')).toBe(
            'See https://a.example/x & https://b.example in #general for @U999 <3 >'
        );
    });

    it('keeps a special mention readable', () => {
        expect(slackPlainText('<!here> look')).toBe('@here look');
    });
});

describe('withoutMention', () => {
    it('removes each mention of the app only', () => {
        expect(withoutMention(`<@${BOT}> hello <@U2> and <@${BOT}|shipwarden>`, BOT)).toBe('hello <@U2> and');
    });
});

describe('parseStartMessage', () => {
    it('reads the repository by its folder name and the prompt', () => {
        expect(parseStartMessage(`<@${BOT}> web Fix the login bug`, BOT, REPOS)).toEqual({ kind: 'start', repoPath: '/code/web', prompt: 'Fix the login bug' });
    });

    it('reads the display name without regard to case, with a colon after it', () => {
        expect(parseStartMessage(`<@${BOT}> backend: Add a health check\nwith tests`, BOT, REPOS)).toEqual({
            kind: 'start',
            repoPath: '/code/api-server',
            prompt: 'Add a health check\nwith tests'
        });
        expect(parseStartMessage(`<@${BOT}> API-SERVER Add logs`, BOT, REPOS)).toMatchObject({ kind: 'start', repoPath: '/code/api-server' });
    });

    it('converts the Slack markup of the prompt', () => {
        expect(parseStartMessage(`<@${BOT}> web Read <https://x.example/issue/1>`, BOT, REPOS)).toMatchObject({ prompt: 'Read https://x.example/issue/1' });
    });

    it('gives help with the repository names for an unknown repository', () => {
        const result = parseStartMessage(`<@${BOT}> mobile Fix it`, BOT, REPOS);
        expect(result.kind).toBe('help');
        expect(result.kind === 'help' && result.text).toContain('no repository with the name "mobile"');
        expect(result.kind === 'help' && result.text).toContain('`web`, `api-server`');
    });

    it('gives help for a message without a prompt or without text', () => {
        expect(parseStartMessage(`<@${BOT}> web`, BOT, REPOS)).toMatchObject({ kind: 'help' });
        expect(parseStartMessage(`<@${BOT}>`, BOT, REPOS)).toMatchObject({ kind: 'help' });
    });

    it('gives help when two repositories have the same name', () => {
        const repos = [...REPOS, { path: '/other/web', name: 'web' }];
        expect(parseStartMessage(`<@${BOT}> web Fix it`, BOT, repos)).toMatchObject({ kind: 'help' });
    });
});

describe('slackAction', () => {
    const context = (threads: Record<string, string> = {}, allowed = ['UALLOWED']): EventContext => ({
        botUserId: BOT,
        channelId: 'C1',
        allowedUserIds: allowed,
        sessionOfThread: ts => threads[ts]
    });
    const message = (change: Partial<SlackEvent>): SlackEvent => ({ type: 'message', channel: 'C1', user: 'UALLOWED', text: 'yes', ts: '2.0', ...change });

    it('maps a reply in an agent thread to the agent', () => {
        expect(slackAction(message({ thread_ts: '1.0', text: 'Use &lt;main&gt;' }), context({ '1.0': 's1' }))).toEqual({
            kind: 'reply',
            sessionId: 's1',
            text: 'Use <main>',
            user: 'UALLOWED',
            ts: '2.0',
            threadTs: '1.0'
        });
    });

    it('ignores messages outside agent threads, in other channels, of bots, and edits', () => {
        const threads = { '1.0': 's1' };
        expect(slackAction(message({}), context(threads))).toEqual({ kind: 'ignore' });
        expect(slackAction(message({ thread_ts: '9.0' }), context(threads))).toEqual({ kind: 'ignore' });
        expect(slackAction(message({ thread_ts: '1.0', channel: 'C2' }), context(threads))).toEqual({ kind: 'ignore' });
        expect(slackAction(message({ thread_ts: '1.0', bot_id: 'B1' }), context(threads))).toEqual({ kind: 'ignore' });
        expect(slackAction(message({ thread_ts: '1.0', user: BOT }), context(threads))).toEqual({ kind: 'ignore' });
        expect(slackAction(message({ thread_ts: '1.0', subtype: 'message_changed' }), context(threads))).toEqual({ kind: 'ignore' });
        // The first message of a thread has the same thread_ts and ts.
        expect(slackAction(message({ thread_ts: '1.0', ts: '1.0' }), context(threads))).toEqual({ kind: 'ignore' });
    });

    it('denies a reply of a person who is not on the allow list', () => {
        expect(slackAction(message({ thread_ts: '1.0', user: 'UOTHER' }), context({ '1.0': 's1' }))).toEqual({
            kind: 'denied',
            user: 'UOTHER',
            ts: '2.0',
            threadTs: '1.0'
        });
    });

    it('maps a mention to a start, with the message as the thread', () => {
        const mention = message({ type: 'app_mention', text: `<@${BOT}> web Fix it`, ts: '5.0' });
        expect(slackAction(mention, context())).toEqual({ kind: 'start', text: `<@${BOT}> web Fix it`, user: 'UALLOWED', ts: '5.0', threadTs: '5.0' });
        expect(slackAction({ ...mention, thread_ts: '4.0' }, context())).toMatchObject({ kind: 'start', threadTs: '4.0' });
    });

    it('uses only the message event for a mention in an agent thread', () => {
        const threads = { '1.0': 's1' };
        const mention = message({ type: 'app_mention', text: `<@${BOT}> 2`, thread_ts: '1.0' });
        expect(slackAction(mention, context(threads))).toEqual({ kind: 'ignore' });
        expect(slackAction({ ...mention, type: 'message' }, context(threads))).toMatchObject({ kind: 'reply', text: '2' });
    });

    it('denies a mention of a person who is not on the allow list, also with an empty list', () => {
        const mention = message({ type: 'app_mention', text: `<@${BOT}> web Fix it` });
        expect(slackAction(mention, context({}, []))).toMatchObject({ kind: 'denied', user: 'UALLOWED' });
    });
});

describe('agentInput', () => {
    it('sends one digit as a key press', () => {
        expect(agentInput(' 2 ')).toEqual({ data: '2', submit: false });
    });

    it('pastes other text and submits it', () => {
        expect(agentInput('Use the main branch')).toEqual({ data: '\x1b[200~Use the main branch\x1b[201~', submit: true });
        expect(agentInput('12')).toMatchObject({ submit: true });
    });
});

describe('needsInputText', () => {
    it('quotes the question and tells how to answer', () => {
        const text = needsInputText({ worktree: 'fix-login', agent: 'Claude Code', waitFor: 'permission', message: 'Run <rm -rf dist>?\nIt deletes files.' });
        expect(text).toBe(
            ':raising_hand: *fix-login* (Claude Code) is asking for permission.\n> Run &lt;rm -rf dist&gt;?\n> It deletes files.\n_Reply in this thread to answer. Reply with a number to select that option._'
        );
    });

    it('works without a worktree and a message', () => {
        expect(needsInputText({})).toBe(':raising_hand: An agent is waiting for input.\n_Reply in this thread to send the text to the agent._');
    });

    it('shortens a long question', () => {
        expect(needsInputText({ message: 'x'.repeat(5000) }).length).toBeLessThan(2700);
    });
});

describe('deniedText', () => {
    it('gives the member ID', () => {
        expect(deniedText('U7')).toContain('`U7`');
    });
});
