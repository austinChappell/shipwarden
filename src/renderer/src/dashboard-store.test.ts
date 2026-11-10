import { describe, expect, it } from 'vitest';
import type { DashboardPullRequests, MyPullRequestItem, PullRequestCommentItem, ReviewRequestItem } from '@shared/dashboard';
import { findDashboardNews, withMergedComments, withoutMergedPullRequests, type TaskActivity } from './dashboard-store';

const repo = { owner: 'acme', name: 'app' };

function review(number: number): ReviewRequestItem {
    return { repo, number, title: `Review ${number}`, url: `u/${number}`, author: 'ann', updatedAt: '', createdAt: '' };
}

function mine(number: number, reasons: MyPullRequestItem['reasons'] = ['ready-to-merge']): MyPullRequestItem {
    return { repo, number, title: `Mine ${number}`, url: `u/${number}`, updatedAt: '', reasons };
}

function comment(id: string, number = 1, extra: Partial<PullRequestCommentItem> = {}): PullRequestCommentItem {
    return { id, repo, number, prTitle: '', prUrl: '', author: 'bob', text: '', html: '', createdAt: '', url: '', ...extra };
}

const tasks: TaskActivity[] = [{ connectionId: 'c1', name: 'ClickUp', comments: [{ id: 't1', taskId: 'x', taskTitle: 'X', body: '', createdAt: '' }] }];

describe('findDashboardNews', () => {
    it('gives no news for the first refresh', () => {
        const result = findDashboardNews(undefined, { reviewRequests: [review(1)], myPullRequests: [] }, [comment('a')], tasks);
        expect(result.news).toBeUndefined();
        expect(result.known.size).toBe(3);
    });

    it('gives the items that the earlier refreshes did not have', () => {
        const first = findDashboardNews(undefined, { reviewRequests: [review(1)], myPullRequests: [mine(2, ['ci-failing'])] }, [comment('a')], []);
        const second = findDashboardNews(
            first.known,
            { reviewRequests: [review(1), review(3)], myPullRequests: [mine(2, ['ci-failing', 'conflicts'])] },
            [comment('a'), comment('b')],
            tasks
        );
        expect(second.news?.reviewRequests.map(item => item.number)).toEqual([3]);
        expect(second.news?.myPullRequests.map(item => item.number)).toEqual([2]);
        expect(second.news?.prComments.map(item => item.id)).toEqual(['b']);
        expect(second.news?.taskComments.map(item => item.comment.id)).toEqual(['t1']);
    });

    it('gives no news when nothing is new, and ignores approvals of merged pull requests', () => {
        const data: DashboardPullRequests = { reviewRequests: [review(1)], myPullRequests: [] };
        const first = findDashboardNews(undefined, data, [], []);
        const second = findDashboardNews(first.known, data, [comment('a', 1, { reviewState: 'APPROVED', prState: 'MERGED' })], []);
        expect(second.news).toBeUndefined();
    });
});

describe('merged pull requests', () => {
    it('removes them from the lists of the Dashboard', () => {
        const data = { reviewRequests: [review(1), review(2)], myPullRequests: [mine(3), mine(4)] };
        const result = withoutMergedPullRequests(data, [
            { repo: { owner: 'ACME', name: 'App' }, number: 2 },
            { repo, number: 3 }
        ]);
        expect(result.reviewRequests.map(item => item.number)).toEqual([1]);
        expect(result.myPullRequests.map(item => item.number)).toEqual([4]);
    });

    it('sets the state MERGED on their comments only', () => {
        const result = withMergedComments([comment('a', 1), comment('b', 2)], [{ repo, number: 2 }]);
        expect(result.map(item => item.prState)).toEqual([undefined, 'MERGED']);
    });
});
