import { describe, expect, it } from 'vitest';
import {
    checkLevel,
    checkSummary,
    commitsAfter,
    diffSize,
    lastActivityOf,
    matchesSearch,
    reviewActivitySeenKey,
    reviewGroup,
    reviewQueue,
    sortPullRequests,
    summarizeRepo,
    type OpenPullRequest,
    type RepoPullRequests
} from './review-queue';

function pr(change: Partial<OpenPullRequest> = {}): OpenPullRequest {
    return {
        id: 'id',
        number: 1,
        title: 'Title',
        url: 'https://github.com/o/r/pull/1',
        author: 'someone',
        isDraft: false,
        createdAt: '2026-11-01T00:00:00Z',
        updatedAt: '2026-11-02T00:00:00Z',
        headRefName: 'feature',
        baseRefName: 'main',
        headRefOid: 'head',
        additions: 10,
        deletions: 2,
        changedFiles: 1,
        comments: 0,
        viewerDidAuthor: false,
        reviewRequested: false,
        reviewDecision: null,
        checks: { state: null, failing: 0, pending: 0, total: 0 },
        actions: [],
        ...change
    };
}

describe('reviewGroup', () => {
    it('puts a requested review without an earlier review in "new"', () => {
        expect(reviewGroup(pr({ reviewRequested: true }))).toBe('new');
    });

    it('puts a requested review with an earlier review in "re-review"', () => {
        expect(reviewGroup(pr({ reviewRequested: true, viewerReview: { state: 'COMMENTED', submittedAt: '2026-11-02T00:00:00Z', commitOid: 'head' } }))).toBe(
            're-review'
        );
    });

    it('puts a reviewed pull request with a new head in "re-review"', () => {
        expect(reviewGroup(pr({ viewerReview: { state: 'CHANGES_REQUESTED', submittedAt: '2026-11-02T00:00:00Z', commitOid: 'old' } }))).toBe('re-review');
    });

    it('puts a commented pull request with a new head in "re-review"', () => {
        expect(reviewGroup(pr({ viewerReview: { state: 'COMMENTED', submittedAt: '2026-11-02T00:00:00Z', commitOid: 'old' } }))).toBe('re-review');
    });

    it('puts an approved pull request with a new comment from another person in "re-review"', () => {
        const value = pr({
            viewerReview: { state: 'APPROVED', submittedAt: '2026-11-02T00:00:00Z', commitOid: 'head' },
            lastActivityAt: '2026-11-03T00:00:00Z'
        });
        expect(reviewGroup(value)).toBe('re-review');
    });

    it('ignores a comment from before the review', () => {
        const value = pr({
            viewerReview: { state: 'COMMENTED', submittedAt: '2026-11-02T00:00:00Z', commitOid: 'head' },
            lastActivityAt: '2026-11-01T00:00:00Z'
        });
        expect(reviewGroup(value)).toBe('waiting');
    });

    it('puts activity that the viewer marked as seen in "waiting", and shows the pull request again after new activity', () => {
        const review = { state: 'COMMENTED', submittedAt: '2026-11-02T00:00:00Z', commitOid: 'old' };
        const seen = new Set([reviewActivitySeenKey(pr({ viewerReview: review }))]);
        const isSeen = (key: string) => seen.has(key);
        expect(reviewGroup(pr({ viewerReview: review }), isSeen)).toBe('waiting');
        expect(reviewGroup(pr({ viewerReview: review, headRefOid: 'newer' }), isSeen)).toBe('re-review');
        expect(reviewGroup(pr({ viewerReview: review, lastActivityAt: '2026-11-04T00:00:00Z' }), isSeen)).toBe('re-review');
    });

    it('keeps a request from GitHub in "re-review" when the activity is seen', () => {
        const review = { state: 'COMMENTED', submittedAt: '2026-11-02T00:00:00Z', commitOid: 'old' };
        expect(reviewGroup(pr({ reviewRequested: true, viewerReview: review }), () => true)).toBe('re-review');
    });

    it('puts a reviewed pull request without changes in "waiting"', () => {
        expect(reviewGroup(pr({ viewerReview: { state: 'APPROVED', submittedAt: '2026-11-02T00:00:00Z', commitOid: 'head' } }))).toBe('waiting');
    });

    it('puts a pull request of the viewer in "mine"', () => {
        expect(reviewGroup(pr({ viewerDidAuthor: true, reviewRequested: true }))).toBe('mine');
    });

    it('puts a reviewed draft without a request in "other"', () => {
        expect(reviewGroup(pr({ isDraft: true, viewerReview: { state: 'COMMENTED', submittedAt: '2026-11-02T00:00:00Z', commitOid: 'old' } }))).toBe('other');
    });
});

describe('lastActivityOf', () => {
    it('returns the newest item from another person, and ignores the viewer and bots', () => {
        expect(
            lastActivityOf('Me', [
                { at: '2026-11-01T00:00:00Z', author: { login: 'alice' } },
                { at: '2026-11-05T00:00:00Z', author: { login: 'me' } },
                { at: '2026-11-04T00:00:00Z', author: { __typename: 'Bot', login: 'ci' } },
                { at: '2026-11-04T00:00:00Z', author: { login: 'renovate[bot]' } },
                { at: '2026-11-03T00:00:00Z', author: { login: 'bob' } },
                { at: null, author: { login: 'carol' } }
            ])
        ).toBe('2026-11-03T00:00:00Z');
        expect(lastActivityOf('me', [])).toBeUndefined();
    });
});

describe('checkSummary', () => {
    it('counts the failed and the running checks', () => {
        const summary = checkSummary('FAILURE', [
            { state: 'SUCCESS', count: 3 },
            { state: 'FAILURE', count: 1 },
            { state: 'TIMED_OUT', count: 1 },
            { state: 'IN_PROGRESS', count: 2 }
        ]);
        expect(summary).toEqual({ state: 'FAILURE', failing: 2, pending: 2, total: 7 });
        expect(checkLevel(summary)).toBe('failing');
    });

    it('uses the state when GitHub gives no counts', () => {
        expect(checkLevel(checkSummary('PENDING', []))).toBe('running');
        expect(checkLevel(checkSummary('SUCCESS', []))).toBe('passing');
        expect(checkLevel(checkSummary(null, []))).toBe('none');
    });
});

describe('commitsAfter', () => {
    it('counts the commits after the reviewed commit', () => {
        expect(commitsAfter(['a', 'b', 'c', 'd'], 'b')).toBe(2);
        expect(commitsAfter(['a', 'b'], 'b')).toBe(0);
    });

    it('returns null when the commit is not in the history', () => {
        expect(commitsAfter(['a', 'b'], 'x')).toBeNull();
        expect(commitsAfter(['a', 'b'], null)).toBeNull();
    });
});

describe('summarizeRepo', () => {
    it('counts the groups and finds the oldest waiting pull request', () => {
        const data: RepoPullRequests = {
            viewer: 'me',
            openCount: 5,
            pushedAt: '2026-11-03T00:00:00Z',
            pullRequests: [
                pr({ number: 1, reviewRequested: true, createdAt: '2026-11-05T00:00:00Z', checks: { state: 'FAILURE', failing: 1, pending: 0, total: 2 } }),
                pr({
                    number: 2,
                    reviewRequested: true,
                    viewerReview: { state: 'APPROVED', submittedAt: '2026-11-02T00:00:00Z', commitOid: 'x' },
                    createdAt: '2026-10-30T00:00:00Z'
                }),
                pr({ number: 3, viewerDidAuthor: true, actions: ['ci-failing'], createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-08T00:00:00Z' }),
                pr({ number: 4, viewerDidAuthor: true, createdAt: '2026-10-01T00:00:00Z' }),
                pr({ number: 5, createdAt: '2026-09-01T00:00:00Z' })
            ]
        };
        const summary = summarizeRepo(data);
        expect(summary).toMatchObject({ toReview: 1, reReview: 1, yourPrs: 1, oldest: '2026-10-30T00:00:00Z', failing: 1, openCount: 5 });
        expect(summary.lastActivity).toBe('2026-11-08T00:00:00Z');
    });
});

describe('sortPullRequests', () => {
    const list = [
        pr({ number: 1, createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z', additions: 500, deletions: 0 }),
        pr({ number: 2, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-08T00:00:00Z', additions: 5, deletions: 5 }),
        pr({ number: 3, createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', additions: 50, deletions: 0 })
    ];

    it('sorts by the longest wait, the last update and the size', () => {
        expect(sortPullRequests(list, 'waiting').map(item => item.number)).toEqual([2, 3, 1]);
        expect(sortPullRequests(list, 'updated').map(item => item.number)).toEqual([2, 1, 3]);
        expect(sortPullRequests(list, 'smallest').map(item => item.number)).toEqual([2, 3, 1]);
    });
});

describe('matchesSearch', () => {
    const item = pr({ number: 3906, title: 'ENG-12023 Dedupe parents', author: 'prestoengineering', headRefName: 'eng-12023-dedupe' });

    it('matches the number, the ticket, the author and the words of the title', () => {
        expect(matchesSearch(item, '#3906')).toBe(true);
        expect(matchesSearch(item, '3906')).toBe(true);
        expect(matchesSearch(item, 'eng-12023')).toBe(true);
        expect(matchesSearch(item, 'presto dedupe')).toBe(true);
        expect(matchesSearch(item, 'dedupe missing')).toBe(false);
    });
});

describe('diffSize', () => {
    it('gives the size class and a fill between 0 and 1', () => {
        expect(diffSize(0, 0)).toEqual({ size: 'small', fill: 0 });
        expect(diffSize(400, 0).size).toBe('medium');
        expect(diffSize(5000, 0)).toEqual({ size: 'large', fill: 1 });
    });
});

describe('reviewQueue', () => {
    it('lists the pull requests to review in all repositories, the oldest first', () => {
        const repos = new Map<string, RepoPullRequests>([
            [
                'o/a',
                { viewer: 'me', openCount: 2, pullRequests: [pr({ number: 1, reviewRequested: true, createdAt: '2026-11-05T00:00:00Z' }), pr({ number: 2 })] }
            ],
            ['o/b', { viewer: 'me', openCount: 1, pullRequests: [pr({ number: 7, reviewRequested: true, createdAt: '2026-11-01T00:00:00Z' })] }]
        ]);
        expect(reviewQueue(repos).map(item => `${item.repo}#${item.number}`)).toEqual(['o/b#7', 'o/a#1']);
    });
});
