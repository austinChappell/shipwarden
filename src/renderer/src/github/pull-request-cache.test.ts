import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { DashboardPullRequests, PullRequestCommentItem } from '@shared/dashboard';
import type { BranchStatus, BranchSummary, PullRequest } from '@shared/github';
import type { OpenPullRequest, RepoPullRequests } from '@shared/review-queue';
import { keyRoots } from '../query-client';
import {
    cachedPullRequest,
    changedPullRequest,
    decisionAfterReview,
    invalidatePullRequest,
    mergedPullRequest,
    patchBranchSummaries,
    patchCachedData,
    patchCommentItems,
    patchDashboardPullRequests,
    patchRepoPullRequests,
    reviewedPullRequest,
    viewerOf,
    withReply,
    withThreadResolved,
    writePullRequest
} from './pull-request-cache';

const URL = 'https://github.com/acme/app/pull/7';
const repo = { owner: 'acme', name: 'app' };

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
    return {
        id: 'PR_7',
        number: 7,
        title: 'Add cache',
        body: 'Text',
        url: URL,
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        reviewDecision: 'REVIEW_REQUIRED',
        author: { login: 'ann' },
        baseRefName: 'main',
        headRefName: 'feature',
        baseRefOid: 'base1',
        headRefOid: 'head1',
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        createdAt: '2026-01-01T00:00:00Z',
        viewerDidAuthor: false,
        reviews: [],
        issueComments: [],
        threads: [
            {
                id: 'T1',
                path: 'a.ts',
                line: 3,
                originalLine: 3,
                side: 'RIGHT',
                isResolved: false,
                isOutdated: false,
                comments: [{ id: 'C1', databaseId: 11, author: { login: 'bob' }, body: 'Why?', createdAt: '2026-01-01T00:00:00Z', url: `${URL}#c1` }]
            }
        ],
        allowedMergeMethods: ['squash'],
        defaultMergeMethod: 'squash',
        commits: [],
        commitCount: 1,
        checkCount: 0,
        assignees: [],
        reviewRequests: [{ kind: 'user', login: 'me' }],
        viewerIsRequested: true,
        labels: [],
        viewerCanUpdate: true,
        viewerCanManage: true,
        autoMerge: null,
        viewerCanEnableAutoMerge: true,
        viewerCanDisableAutoMerge: false,
        viewerCanMerge: true,
        ...overrides
    };
}

function makeOpen(overrides: Partial<OpenPullRequest> = {}): OpenPullRequest {
    return {
        id: 'PR_7',
        number: 7,
        title: 'Add cache',
        url: URL,
        author: 'ann',
        isDraft: false,
        createdAt: '',
        updatedAt: '',
        headRefName: 'feature',
        baseRefName: 'main',
        headRefOid: 'head1',
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        comments: 0,
        viewerDidAuthor: false,
        reviewRequested: true,
        reviewDecision: 'REVIEW_REQUIRED',
        checks: { state: null, failing: 0, pending: 0, total: 0 },
        actions: [],
        ...overrides
    };
}

const summary: BranchSummary = { number: 7, url: URL, isDraft: false, reviewDecision: 'REVIEW_REQUIRED', checks: null };

describe('decisionAfterReview', () => {
    it('sets the decision from the review event', () => {
        expect(decisionAfterReview('REVIEW_REQUIRED', 'APPROVE')).toBe('APPROVED');
        expect(decisionAfterReview('CHANGES_REQUESTED', 'APPROVE')).toBe('CHANGES_REQUESTED');
        expect(decisionAfterReview('APPROVED', 'REQUEST_CHANGES')).toBe('CHANGES_REQUESTED');
        expect(decisionAfterReview('APPROVED', 'REJECT')).toBe('CHANGES_REQUESTED');
        expect(decisionAfterReview(null, 'APPROVE_WITH_SUGGESTIONS')).toBe('APPROVED');
        expect(decisionAfterReview('REVIEW_REQUIRED', 'COMMENT')).toBe('REVIEW_REQUIRED');
    });
});

describe('pull request changes', () => {
    it('merges a pull request', () => {
        const pr = mergedPullRequest(makePr({ autoMerge: { method: 'squash', enabledBy: 'ann' } }));
        expect(pr.state).toBe('MERGED');
        expect(pr.autoMerge).toBeNull();
    });

    it('applies the details, the draft state and the auto-merge', () => {
        const pr = makePr();
        expect(changedPullRequest(pr, { kind: 'details', title: 'New', state: 'closed' })).toMatchObject({ title: 'New', body: 'Text', state: 'CLOSED' });
        expect(changedPullRequest(pr, { kind: 'draft', pullRequestId: 'PR_7', draft: true }).isDraft).toBe(true);
        expect(changedPullRequest(pr, { kind: 'autoMerge', pullRequestId: 'PR_7', method: 'squash', headSha: 'head1' }, [], { login: 'me' }).autoMerge).toEqual(
            {
                method: 'squash',
                enabledBy: 'me'
            }
        );
    });

    it('applies a label with its known color', () => {
        const pr = changedPullRequest(makePr(), { kind: 'label', name: 'bug', add: true }, [{ name: 'bug', color: 'ff0000' }]);
        expect(pr.labels).toEqual([{ name: 'bug', color: 'ff0000' }]);
    });

    it('adds a reply and resolves a thread', () => {
        const reply = { id: 'local', databaseId: 11, author: { login: 'me' }, body: 'Because.', createdAt: '', url: '' };
        expect(withReply(makePr(), 'T1', reply).threads[0].comments.map(comment => comment.body)).toEqual(['Why?', 'Because.']);
        expect(withThreadResolved(makePr(), 'T1', true).threads[0].isResolved).toBe(true);
    });

    it('adds a review and removes the review request of the viewer', () => {
        const pr = reviewedPullRequest(makePr(), { id: 'R', event: 'APPROVE', body: 'Good', viewer: { login: 'me' }, submittedAt: 'now' });
        expect(pr.reviews).toEqual([{ id: 'R', author: { login: 'me' }, state: 'APPROVED', body: 'Good', submittedAt: 'now', url: URL }]);
        expect(pr.reviewDecision).toBe('APPROVED');
        expect(pr.reviewRequests).toEqual([]);
        expect(pr.viewerIsRequested).toBe(false);
    });
});

describe('list patches', () => {
    it('updates and removes branch summaries', () => {
        const summaries = { feature: summary, other: { ...summary, number: 8, url: 'other' } };
        expect(patchBranchSummaries(summaries, makePr({ isDraft: true })).feature.isDraft).toBe(true);
        expect(Object.keys(patchBranchSummaries(summaries, makePr({ state: 'MERGED' })))).toEqual(['other']);
        const unrelated = { other: summaries.other };
        expect(patchBranchSummaries(unrelated, makePr())).toBe(unrelated);
    });

    it('updates the open pull requests of a repository', () => {
        const data: RepoPullRequests = { viewer: 'me', openCount: 2, pullRequests: [makeOpen(), makeOpen({ url: 'other' })] };
        const reviewed = patchRepoPullRequests(data, makePr({ reviewDecision: 'APPROVED' }), { state: 'APPROVED', submittedAt: 'now' });
        expect(reviewed.pullRequests[0]).toMatchObject({
            reviewDecision: 'APPROVED',
            reviewRequested: false,
            viewerReview: { state: 'APPROVED', submittedAt: 'now', commitOid: 'head1' }
        });
        const merged = patchRepoPullRequests(data, makePr({ state: 'MERGED' }));
        expect(merged.openCount).toBe(1);
        expect(merged.pullRequests.map(item => item.url)).toEqual(['other']);
    });

    it('removes a reviewed or merged pull request from the Dashboard', () => {
        const data: DashboardPullRequests = {
            reviewRequests: [{ repo, number: 7, title: 'Old', url: URL, author: 'ann', updatedAt: '', createdAt: '' }],
            myPullRequests: [{ repo, number: 7, title: 'Old', url: URL, updatedAt: '', reasons: [] }]
        };
        expect(patchDashboardPullRequests(data, makePr()).reviewRequests[0].title).toBe('Add cache');
        expect(patchDashboardPullRequests(data, makePr(), { state: 'COMMENTED', submittedAt: '' }).reviewRequests).toEqual([]);
        expect(patchDashboardPullRequests(data, makePr({ state: 'CLOSED' }))).toEqual({ reviewRequests: [], myPullRequests: [] });
    });

    it('sets the state of the pull request of Dashboard comments', () => {
        const items = [{ id: 'C', repo, number: 7, prTitle: 'Old', prUrl: URL } as PullRequestCommentItem];
        expect(patchCommentItems(items, makePr({ state: 'MERGED' }))[0]).toMatchObject({ prState: 'MERGED', prTitle: 'Add cache' });
    });

    it('patches cached values of each shape and keeps unrelated values', () => {
        const next = makePr({ title: 'New' });
        const status: BranchStatus = { repo, branch: 'feature', sha: 'old', pullRequest: makePr() };
        expect(patchCachedData(makePr(), next)).toBe(next);
        expect(patchCachedData(status, next)).toEqual({ ...status, sha: 'head1', pullRequest: next });
        const other = makePr({ url: 'other' });
        expect(patchCachedData(other, next)).toBe(other);
        const tasks = [{ id: 'task' }];
        expect(patchCachedData(tasks, next)).toBe(tasks);
    });
});

describe('cache writes', () => {
    it('applies a change to the newest cached copy and writes it to all queries', () => {
        const client = new QueryClient();
        const detailKey = [...keyRoots.pullRequest, 'acme/app', 7];
        const statusKey = [...keyRoots.branchStatus, '/work/feature'];
        const summariesKey = [...keyRoots.branchSummaries, '/work/app'];
        const listKey = [...keyRoots.repoPullRequests, 'acme/app'];
        client.setQueryData(detailKey, makePr({ title: 'Cached' }));
        client.setQueryData(statusKey, { repo, branch: 'feature', sha: 'head1', pullRequest: makePr({ title: 'Cached' }) });
        client.setQueryData(summariesKey, { feature: summary });
        client.setQueryData(listKey, { viewer: 'me', openCount: 1, pullRequests: [makeOpen()] });

        const next = writePullRequest(client, makePr(), mergedPullRequest);

        expect(next).toMatchObject({ title: 'Cached', state: 'MERGED' });
        expect(client.getQueryData<PullRequest>(detailKey)?.state).toBe('MERGED');
        expect(client.getQueryData<BranchStatus>(statusKey)?.pullRequest?.state).toBe('MERGED');
        expect(client.getQueryData(summariesKey)).toEqual({});
        expect(client.getQueryData<RepoPullRequests>(listKey)?.pullRequests).toEqual([]);
        expect(cachedPullRequest(client, URL)?.state).toBe('MERGED');
    });

    it('marks only the queries of one pull request as stale', async () => {
        const client = new QueryClient();
        client.setQueryData([...keyRoots.pullRequest, 'a', 7], makePr());
        client.setQueryData([...keyRoots.pullRequest, 'a', 8], makePr({ url: 'other' }));
        await invalidatePullRequest(client, URL);
        expect(client.getQueryState([...keyRoots.pullRequest, 'a', 7])?.isInvalidated).toBe(true);
        expect(client.getQueryState([...keyRoots.pullRequest, 'a', 8])?.isInvalidated).toBe(false);
    });

    it('finds the viewer in the cached list of the repository', () => {
        const client = new QueryClient();
        expect(viewerOf(client, makePr())).toBeNull();
        expect(viewerOf(client, makePr({ viewerDidAuthor: true }))).toEqual({ login: 'ann' });
        client.setQueryData([...keyRoots.repoPullRequests, 'acme/app'], { viewer: 'me', openCount: 1, pullRequests: [makeOpen()] });
        expect(viewerOf(client, makePr())).toEqual({ login: 'me' });
    });
});
