import { describe, expect, it } from 'vitest';
import { groupsOf, planStepOf, samePullRequest, worktreeOfTask } from './item-relations';
import { newPlan, newStep, type Plan, type PlanStep } from './plans';
import { newGroup } from './pr-groups';
import type { TaskLink } from './tasks';

const repo = { owner: 'acme', name: 'api' };
const link: TaskLink = { connectionId: 'clickup', pluginId: 'clickup', taskId: 't1', title: 'Demo flag', url: 'https://example.com/t1' };

function step(patch: Partial<PlanStep>): PlanStep {
    return { ...newStep(), ...patch };
}

function plan(id: string, steps: PlanStep[]): Plan {
    return { ...newPlan('project-1', 1000), id, steps };
}

const linked = step({
    worktreePath: '/work/api-1',
    pr: { number: 42, url: 'https://github.com/acme/api/pull/42', base: 'main' },
    task: { kind: 'existing', link }
});
const plans = [plan('empty', [step({})]), plan('demo', [step({}), linked])];

describe('planStepOf', () => {
    it('finds the step by the worktree, the pull request or the task', () => {
        expect(planStepOf(plans, { worktreePath: '/work/api-1' })?.plan.id).toBe('demo');
        expect(planStepOf(plans, { pullRequest: { repo: { owner: 'Acme', name: 'API' }, number: 42 } })?.step).toBe(linked);
        expect(planStepOf(plans, { task: { connectionId: 'clickup', id: 't1' } })?.plan.id).toBe('demo');
        expect(planStepOf(plans, { task: { connectionId: 'other', id: 'x', url: 'https://example.com/t1' } })).toBeUndefined();
    });

    it('finds nothing without a match or without an anchor', () => {
        expect(planStepOf(plans, { worktreePath: '/work/other' })).toBeUndefined();
        expect(planStepOf(plans, { pullRequest: { repo, number: 7 } })).toBeUndefined();
        expect(planStepOf(plans, {})).toBeUndefined();
    });
});

describe('groupsOf', () => {
    it('finds the groups of the pull request and the group of the plan, one time each', () => {
        const both = { ...newGroup(1, 'Both', [{ repo, number: 42 }]), planId: 'demo' };
        const pr = newGroup(1, 'PR', [{ repo, number: 42 }]);
        const other = newGroup(1, 'Other', [{ repo, number: 7 }]);
        const ofPlan = { ...newGroup(1, 'Plan'), planId: 'demo' };
        expect(groupsOf([both, pr, other, ofPlan], { repo, number: 42 }, 'demo').map(group => group.name)).toEqual(['Both', 'PR', 'Plan']);
        expect(groupsOf([both, pr, other], undefined, undefined)).toEqual([]);
    });
});

describe('worktreeOfTask', () => {
    it('finds the worktree of a task', () => {
        expect(worktreeOfTask({ '/work/a': link }, { connectionId: 'clickup', id: 't1' })).toBe('/work/a');
        expect(worktreeOfTask({ '/work/a': link }, { connectionId: 'clickup', id: 't2' })).toBeUndefined();
    });
});

describe('samePullRequest', () => {
    it('compares the repository without case', () => {
        expect(samePullRequest({ repo, number: 1 }, { repo: { owner: 'ACME', name: 'api' }, number: 1 })).toBe(true);
        expect(samePullRequest({ repo, number: 1 }, { repo, number: 2 })).toBe(false);
    });
});
