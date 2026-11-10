import { describe, expect, it } from 'vitest';
import type { PendingComment, PullRequest, PullRequestFile, ReviewThread } from '@shared/github';
import {
    conversationOf, decisionEvents, firstUndecided, openCommentCount, pendingText, reviewButtons, reviewConfirmTitle,
    reviewEvents, shownCommentIds, undecidedText, visibleThreads
} from './review-state';

const comment = (path: string, parts: Partial<PendingComment> = {}): PendingComment => ({ path, line: 3, side: 'RIGHT', body: 'Fix', ...parts });

const thread = (id: string, path: string, isResolved: boolean): ReviewThread => ({
    id, path, line: 1, originalLine: 1, side: 'RIGHT', isResolved, isOutdated: false,
    comments: [{ id: `${id}-c`, databaseId: 1, author: null, body: '', createdAt: '', url: '' }]
});

function pr(parts: Partial<PullRequest> = {}): PullRequest {
    return { number: 7, viewerDidAuthor: false, issueComments: [], reviews: [], threads: [], ...parts } as PullRequest;
}

describe('reviewEvents', () => {
    it('returns the GitHub events when the host gives no events', () => {
        expect(reviewEvents(pr())).toEqual(['COMMENT', 'REQUEST_CHANGES', 'APPROVE']);
    });

    it('returns the events of the host', () => {
        expect(reviewEvents(pr({ reviewEvents: ['COMMENT', 'APPROVE_WITH_SUGGESTIONS', 'REJECT'] }))).toEqual(['COMMENT', 'APPROVE_WITH_SUGGESTIONS', 'REJECT']);
    });

    it('keeps only the comment for the author of the pull request', () => {
        expect(reviewEvents(pr({ viewerDidAuthor: true }))).toEqual(['COMMENT']);
    });
});

describe('decisionEvents', () => {
    it('shows all events in the panel', () => {
        expect(decisionEvents(['COMMENT', 'APPROVE'], false)).toEqual(['COMMENT', 'APPROVE']);
    });

    it('removes the comment in the Overview tab', () => {
        expect(decisionEvents(['COMMENT', 'REQUEST_CHANGES', 'APPROVE'], true)).toEqual(['REQUEST_CHANGES', 'APPROVE']);
    });

    it('keeps the comment in the Overview tab when it is the only event', () => {
        expect(decisionEvents(['COMMENT'], true)).toEqual(['COMMENT']);
    });
});

describe('reviewButtons', () => {
    const events = reviewEvents(pr());

    it('turns off the comment without text and without pending comments', () => {
        expect(reviewButtons({ events, body: '  ', pending: [], busy: false })).toEqual({ undecided: 0, canComment: false, canDecide: true });
    });

    it('turns on the comment with text or with a pending comment', () => {
        expect(reviewButtons({ events, body: 'Looks good', pending: [], busy: false }).canComment).toBe(true);
        expect(reviewButtons({ events, body: '', pending: [comment('a.ts')], busy: false }).canComment).toBe(true);
    });

    it('turns off all buttons while an action runs', () => {
        expect(reviewButtons({ events, body: 'Text', pending: [], busy: true })).toMatchObject({ canComment: false, canDecide: false });
    });

    it('turns off all buttons while an agent comment waits for a decision', () => {
        const pending = [comment('a.ts'), comment('b.ts', { fromAgent: true, needsDecision: true })];
        expect(reviewButtons({ events, body: 'Text', pending, busy: false })).toEqual({ undecided: 1, canComment: false, canDecide: false });
    });

    it('turns off the comment when the host has no comment event', () => {
        expect(reviewButtons({ events: ['APPROVE'], body: 'Text', pending: [], busy: false }).canComment).toBe(false);
    });
});

describe('firstUndecided', () => {
    const files = [{ path: 'b.ts' }] as PullRequestFile[];

    it('returns the first comment without a decision and its file', () => {
        const target = comment('b.ts', { needsDecision: true });
        expect(firstUndecided([comment('a.ts'), target, comment('c.ts', { needsDecision: true })], files)).toEqual({ comment: target, file: files[0] });
    });

    it('returns no file when the file list has not loaded', () => {
        expect(firstUndecided([comment('b.ts', { needsDecision: true })], undefined)?.file).toBeUndefined();
    });

    it('returns undefined when all comments have a decision', () => {
        expect(firstUndecided([comment('a.ts')], files)).toBeUndefined();
    });
});

describe('reviewConfirmTitle', () => {
    it('names the host, the event and the pull request', () => {
        expect(reviewConfirmTitle(pr(), 'APPROVE', 0)).toBe('Submit a review to GitHub: approve pull request #7?');
    });

    it('counts the inline comments', () => {
        expect(reviewConfirmTitle(pr({ host: 'azure' }), 'REQUEST_CHANGES', 2))
            .toBe('Submit a review to Azure DevOps: request changes on pull request #7 with 2 inline comment(s)?');
    });
});

describe('pendingText and undecidedText', () => {
    it('use the singular for one comment', () => {
        expect(pendingText(1)).toBe('1 pending comment');
        expect(undecidedText(1)).toBe('Accept or remove the 1 agent comment that you did not check yet. Then you can submit your review.');
    });

    it('use the plural for more than one comment', () => {
        expect(pendingText(3)).toBe('3 pending comments');
        expect(undecidedText(2)).toMatch(/^Accept or remove the 2 agent comments that/);
    });
});

describe('openCommentCount', () => {
    it('counts the open threads and the pending comments of one file', () => {
        const threads = [thread('t1', 'a.ts', false), thread('t2', 'a.ts', true), thread('t3', 'b.ts', false)];
        const pending = [comment('a.ts'), comment('b.ts')];
        expect(openCommentCount(threads, pending, 'a.ts')).toBe(2);
        expect(openCommentCount(threads, pending, 'c.ts')).toBe(0);
    });
});

describe('visibleThreads and shownCommentIds', () => {
    const value = pr({
        threads: [thread('open', 'a.ts', false), thread('done', 'a.ts', true)],
        issueComments: [{ id: 'i1', author: null, body: '', createdAt: '', url: '' }],
        reviews: [{ id: 'r1', author: null, state: 'APPROVED', body: '', submittedAt: '', url: '' }]
    });

    it('hides the resolved threads unless the user shows them', () => {
        expect(visibleThreads(value.threads, false).map(item => item.id)).toEqual(['open']);
        expect(visibleThreads(value.threads, true).map(item => item.id)).toEqual(['open', 'done']);
    });

    it('returns the IDs of all comments that the panel shows', () => {
        expect(shownCommentIds(value, false)).toEqual(['i1', 'r1', 'open-c']);
        expect(shownCommentIds(value, true)).toEqual(['i1', 'r1', 'open-c', 'done-c']);
    });
});

describe('conversationOf', () => {
    it('sorts the comments and the reviews by time and leaves out empty comment reviews', () => {
        const items = conversationOf(pr({
            issueComments: [{ id: 'i1', author: { login: 'ann' }, body: 'Hi', createdAt: '2026-01-02', url: '' }],
            reviews: [
                { id: 'r1', author: null, state: 'APPROVED', body: '', submittedAt: '2026-01-01', url: '' },
                { id: 'r2', author: null, state: 'COMMENTED', body: ' ', submittedAt: '2026-01-03', url: '' },
                { id: 'r3', author: null, state: 'DISMISSED', body: '', submittedAt: '2026-01-04', url: '' },
                { id: 'r4', author: { login: 'bob' }, state: 'COMMENTED', body: 'Nit', submittedAt: null, url: '' }
            ]
        }));
        expect(items.map(item => item.id)).toEqual(['r4', 'r1', 'i1']);
        expect(items[2]).toEqual({ id: 'i1', author: 'ann', body: 'Hi', createdAt: '2026-01-02' });
        expect(items[1].state).toBe('APPROVED');
    });
});
