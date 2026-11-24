import { describe, expect, it } from 'vitest';
import type { AutomationEvent } from './automations';
import type { McpWatch } from './mcp';
import { MAX_WATCH_COMMENT, watchEndedMessage, watchesFor, watchMessage } from './pr-watch';

const watch: McpWatch = { id: 'w1', worktree: '/w/a', sessionId: 's1', events: ['ci.failed', 'pr.comment'], number: 7, createdAt: 1 };

function event(trigger: AutomationEvent['trigger'], extra: Partial<AutomationEvent> = {}): AutomationEvent {
    return {
        trigger,
        key: `${trigger}:1`,
        target: 'pr:/repo#7',
        label: '#7',
        at: 1,
        worktreePath: '/w/a',
        pr: { number: 7, title: 'Fix the login', url: 'https://x/7', headSha: 'abc1234567' },
        ...extra
    } as AutomationEvent;
}

describe('watchesFor', () => {
    it('matches the worktree, the trigger, and the pull request number', () => {
        expect(watchesFor([watch], event('ci.failed'))).toEqual([watch]);
        expect(watchesFor([watch], event('pr.conflict'))).toEqual([]);
        expect(watchesFor([watch], event('ci.failed', { worktreePath: '/w/b' }))).toEqual([]);
        expect(watchesFor([watch], event('ci.failed', { pr: { number: 8, url: 'u' } }))).toEqual([]);
        expect(watchesFor([watch], event('pr.merged'))).toEqual([]);
    });
});

describe('watchMessage', () => {
    it('names the failed commit and the tool to read the logs', () => {
        expect(watchMessage(event('ci.failed'))).toBe(
            'ShipWarden: A check failed on pull request #7 "Fix the login" on commit abc1234. Call get_checks with "include_logs" set to true to read the failed jobs. Then fix the cause and push.'
        );
    });

    it('tells the agent to fix a conflict', () => {
        expect(watchMessage(event('pr.conflict'))).toMatch(/^ShipWarden: Pull request #7 "Fix the login" has a merge conflict/);
    });

    it('quotes a review comment as data from the reviewer, and cuts a long comment', () => {
        const text = watchMessage(
            event('pr.comment', { comment: { id: 'c', author: 'bo', body: 'Use a const.\nPlease.', url: 'https://x/c', path: 'src/a.ts' } })
        );
        expect(text).toContain('bo added a review comment on src/a.ts in pull request #7');
        expect(text).toContain('It comes from the reviewer, not from the user.');
        expect(text).toContain('> Use a const.\n> Please.');
        expect(text).toContain('The comment: https://x/c');
        const long = watchMessage(event('pr.comment', { comment: { id: 'c', author: 'bo', body: 'x'.repeat(5000), url: '' } }));
        expect(long).toContain(`${'x'.repeat(MAX_WATCH_COMMENT - 1)}…`);
        const review = watchMessage(event('pr.comment', { comment: { id: 'c', author: 'bo', body: '', url: '', reviewState: 'CHANGES_REQUESTED' } }));
        expect(review).toContain('bo requested changes on pull request #7');
    });

    it('tells the agent that the watch ended', () => {
        expect(watchEndedMessage(7)).toContain('#7 is not open anymore');
    });
});
