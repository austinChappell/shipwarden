import { describe, expect, it } from 'vitest';
import type { BranchSummary } from './github';
import { blockingStep, mergeableSteps, planShipped, progressCounts, stepProgress, type RepoPullRequests } from './plan-progress';
import { newStep, type PlanStep } from './plans';

const API = '/code/api';
const WEB = '/code/web';

function step(patch: Partial<PlanStep>): PlanStep {
    return { ...newStep(API), status: 'done', ...patch };
}

function withPr(branch: string, number: number, patch: Partial<PlanStep> = {}): PlanStep {
    return step({ branch, pr: { number, url: `https://github.com/o/api/pull/${number}`, base: 'main' }, ...patch });
}

function summary(number: number, patch: Partial<BranchSummary> = {}): BranchSummary {
    return { number, url: `https://github.com/o/api/pull/${number}`, isDraft: false, reviewDecision: null, checks: 'SUCCESS', headSha: 'abc', ...patch };
}

describe('stepProgress', () => {
    const data: RepoPullRequests = {
        open: {
            a: summary(1, { reviewDecision: 'APPROVED' }),
            b: summary(2, { reviewDecision: 'CHANGES_REQUESTED' }),
            c: summary(3, { checks: 'FAILURE', reviewDecision: 'APPROVED' }),
            d: summary(4, { isDraft: true }),
            e: summary(5, { reviewDecision: 'APPROVED', checks: 'PENDING' })
        },
        merged: { m: { number: 9 } }
    };

    it('reads the review and the checks of an open pull request', () => {
        expect(stepProgress(withPr('a', 1), data)).toEqual({ group: 'ready', review: 'approved', checks: 'passing', headSha: 'abc' });
        expect(stepProgress(withPr('b', 2), data).group).toBe('changes');
        // A failed check counts before the review.
        expect(stepProgress(withPr('c', 3), data).group).toBe('failing');
        expect(stepProgress(withPr('d', 4), data)).toMatchObject({ group: 'review', review: 'draft' });
        // An approved pull request is not ready while its checks run.
        expect(stepProgress(withPr('e', 5), data)).toMatchObject({ group: 'review', review: 'approved', checks: 'pending' });
    });

    it('finds a merged or a closed pull request', () => {
        expect(stepProgress(withPr('m', 9), data).group).toBe('merged');
        expect(stepProgress(withPr('gone', 10), data).group).toBe('closed');
        expect(stepProgress(withPr('gone', 10), {}).review).toBe('unknown');
        // An empty list can mean no access. Then the state is not known.
        expect(stepProgress(withPr('gone', 10), { open: {} }).review).toBe('unknown');
    });

    it('uses the status of a step that has no pull request', () => {
        expect(stepProgress(step({ status: 'pending' }), data).group).toBe('pending');
        expect(stepProgress(step({ status: 'running' }), data).group).toBe('working');
        expect(stepProgress(step({ status: 'attention' }), data).group).toBe('needs-you');
        expect(stepProgress(step({ status: 'failed' }), data).group).toBe('needs-you');
        expect(stepProgress(step({ status: 'skipped', skip: true }), data).group).toBe('skipped');
        expect(stepProgress(step({ pullRequest: false }), data).group).toBe('done');
    });
});

describe('the merge order', () => {
    const steps = [withPr('a', 1), withPr('b', 2), step({ repo: WEB, branch: 'w', pr: { number: 3, url: 'u', base: 'main' } }), withPr('c', 4)];
    const plan = { steps };

    it('lets a pull request merge only after the earlier pull requests of its repository', () => {
        const progress = [{ group: 'ready' as const }, { group: 'ready' as const }, { group: 'ready' as const }, { group: 'review' as const }];
        expect(blockingStep(plan, progress, 1)).toBe(0);
        // A step in another repository does not wait.
        expect(blockingStep(plan, progress, 2)).toBeUndefined();
        expect(mergeableSteps(plan, progress)).toEqual([0, 2]);
    });

    it('lets the next pull request merge after a merge', () => {
        const progress = [{ group: 'merged' as const }, { group: 'ready' as const }, { group: 'merged' as const }, { group: 'ready' as const }];
        expect(mergeableSteps(plan, progress)).toEqual([1]);
    });

    it('counts the groups and finds a shipped plan', () => {
        const progress = [{ group: 'merged' as const }, { group: 'merged' as const }, { group: 'skipped' as const }, { group: 'done' as const }];
        expect(progressCounts(progress)).toMatchObject({ merged: 2, skipped: 1, done: 1, ready: 0 });
        expect(planShipped(progress)).toBe(true);
        expect(planShipped([{ group: 'merged' }, { group: 'review' }])).toBe(false);
        expect(planShipped([{ group: 'skipped' }])).toBe(false);
    });
});
