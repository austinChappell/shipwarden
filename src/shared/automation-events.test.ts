import { describe, expect, it } from 'vitest';
import {
    agentDoneEvent,
    ciFailedEvents,
    closedPullRequests,
    commentEvents,
    conflictEvents,
    mergedEvent,
    pullRequestResolver,
    taskEvent,
    worktreeOnBranch,
    type WorktreePlace
} from './automation-events';
import { branchName } from './automations';
import type { MyPullRequestItem, PullRequestCommentItem } from './dashboard';
import type { BranchSummary } from './github';

const places: WorktreePlace[] = [
    { repo: '/repo', worktree: { path: '/repo', branch: 'main', isMain: true } },
    { repo: '/repo', worktree: { path: '/wt/feature', branch: 'feature', isMain: false } }
];

function summary(change: Partial<BranchSummary> = {}): BranchSummary {
    return {
        number: 7,
        title: 'Add login',
        url: 'https://github.com/o/r/pull/7',
        headSha: 'abc',
        isDraft: false,
        reviewDecision: null,
        checks: 'PENDING',
        ...change
    };
}

const repo = { owner: 'o', name: 'r' };
const resolve = pullRequestResolver({ '/repo': repo, '/other': null }, { '/repo': { feature: summary() } }, places);

describe('worktreeOnBranch', () => {
    it('finds the worktree of a branch, but not the main worktree', () => {
        expect(worktreeOnBranch(places, '/repo', 'feature')?.worktree.path).toBe('/wt/feature');
        expect(worktreeOnBranch(places, '/repo', 'main')).toBeUndefined();
        expect(worktreeOnBranch(places, '/repo', undefined)).toBeUndefined();
    });
});

describe('ciFailedEvents', () => {
    it('makes an event when the checks of a worktree branch fail', () => {
        const events = ciFailedEvents('/repo', { feature: summary() }, { feature: summary({ checks: 'FAILURE' }) }, places, 5);
        expect(events).toEqual([
            expect.objectContaining({
                trigger: 'ci.failed',
                key: 'ci:/repo#7@abc',
                target: 'pr:/repo#7',
                worktreePath: '/wt/feature',
                branch: 'feature',
                pr: { number: 7, title: 'Add login', url: 'https://github.com/o/r/pull/7', headSha: 'abc' }
            })
        ]);
    });

    it('makes no event for passed checks, the first load or a branch without a worktree', () => {
        expect(ciFailedEvents('/repo', { feature: summary() }, { feature: summary({ checks: 'SUCCESS' }) }, places, 5)).toEqual([]);
        expect(ciFailedEvents('/repo', undefined, { feature: summary({ checks: 'FAILURE' }) }, places, 5)).toEqual([]);
        expect(ciFailedEvents('/repo', { other: summary() }, { other: summary({ checks: 'FAILURE' }) }, places, 5)).toEqual([]);
    });
});

describe('closedPullRequests and mergedEvent', () => {
    it('finds the pull requests of worktree branches that left the open list', () => {
        const closed = closedPullRequests('/repo', { feature: summary(), gone: summary({ number: 9 }) }, {}, places);
        expect(closed.map(item => item.branch)).toEqual(['feature']);
        expect(closedPullRequests('/repo', { feature: summary() }, { feature: summary() }, places)).toEqual([]);
        const event = mergedEvent('/repo', 'feature', closed[0].summary, closed[0].place, 1);
        expect(event).toMatchObject({ trigger: 'pr.merged', key: 'merged:/repo#7', worktreePath: '/wt/feature' });
    });
});

describe('commentEvents', () => {
    const comment: PullRequestCommentItem = {
        id: 'C1',
        repo,
        number: 7,
        prTitle: 'Add login',
        prUrl: 'u',
        author: 'sam',
        text: 'Rename this.',
        html: '',
        createdAt: '',
        url: 'u#c1',
        path: 'a.ts'
    };

    it('makes an event for a comment on a pull request of a worktree branch', () => {
        expect(commentEvents([comment], resolve, 1)).toEqual([
            expect.objectContaining({
                trigger: 'pr.comment',
                key: 'comment:C1',
                target: 'pr:/repo#7',
                worktreePath: '/wt/feature',
                comment: { id: 'C1', author: 'sam', body: 'Rename this.', url: 'u#c1', path: 'a.ts' }
            })
        ]);
    });

    it('skips approvals, closed pull requests and other repositories', () => {
        expect(commentEvents([{ ...comment, reviewState: 'APPROVED' }], resolve, 1)).toEqual([]);
        expect(commentEvents([{ ...comment, prState: 'MERGED' }], resolve, 1)).toEqual([]);
        expect(commentEvents([{ ...comment, repo: { owner: 'x', name: 'y' } }], resolve, 1)).toEqual([]);
        expect(commentEvents([{ ...comment, number: 8 }], resolve, 1)).toEqual([]);
    });
});

describe('conflictEvents', () => {
    it('makes an event for a pull request with merge conflicts, keyed by its head commit', () => {
        const item: MyPullRequestItem = { repo, number: 7, title: 'Add login', url: 'u', updatedAt: '', reasons: ['conflicts'], headSha: 'def' };
        expect(conflictEvents([item], resolve, 1)).toEqual([expect.objectContaining({ trigger: 'pr.conflict', key: 'conflict:/repo#7@def' })]);
        expect(conflictEvents([{ ...item, reasons: ['ci-failing'] }], resolve, 1)).toEqual([]);
    });
});

describe('agentDoneEvent', () => {
    it('tells whether the branch has a pull request', () => {
        const event = agentDoneEvent({ id: 's1', worktreePath: '/wt/feature' }, { at: 3, message: 'Done.' }, places, {});
        expect(event).toMatchObject({ trigger: 'agent.done', key: 'done:s1:3', target: 'wt:/wt/feature', hasPullRequest: false, agentMessage: 'Done.' });
        const withPr = agentDoneEvent({ id: 's1', worktreePath: '/wt/feature' }, { at: 4 }, places, { '/repo': { feature: summary() } });
        expect(withPr?.hasPullRequest).toBe(true);
    });

    it('ignores the main worktree and unknown folders', () => {
        expect(agentDoneEvent({ id: 's1', worktreePath: '/repo' }, { at: 3 }, places, {})).toBeUndefined();
        expect(agentDoneEvent({ id: 's1', worktreePath: '/x' }, { at: 3 }, places, {})).toBeUndefined();
    });
});

describe('taskEvent', () => {
    it('uses the task as the key and the target', () => {
        const event = taskEvent({ id: 't1', key: 'ENG-1', title: 'Fix', status: { id: 's', name: 'To do', category: 'todo' } }, 'c1', 'clickup', '/repo', 1);
        expect(event).toMatchObject({
            key: 'task:c1:t1',
            target: 'task:c1:t1',
            label: 'ENG-1 Fix',
            connectionId: 'c1',
            pluginId: 'clickup',
            repoPath: '/repo'
        });
    });
});

describe('branchName', () => {
    it('replaces characters that git does not accept', () => {
        expect(branchName('automation/daily summary-2026-11-10-0800')).toBe('automation/daily-summary-2026-11-10-0800');
        expect(branchName(' ../a:b..c// ')).toBe('a-b.c');
        expect(branchName('???')).toBe('automation');
    });
});
