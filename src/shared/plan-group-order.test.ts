import { describe, expect, it } from 'vitest';
import { groupInPlanOrder, orderInPlace, planInGroupOrder, stackLabels } from './plan-group-order';
import { newStep, type PlanStep } from './plans';
import { newGroup, prKey } from './pr-groups';

const api = { owner: 'octo', name: 'api' };
const web = { owner: 'octo', name: 'web' };

function step(id: string, pr?: { repo: string; number: number }): PlanStep {
    return {
        ...newStep(),
        id,
        ...(pr ? { pr: { number: pr.number, url: `https://github.com/octo/${pr.repo}/pull/${pr.number}`, base: 'main' } } : {})
    };
}

describe('orderInPlace', () => {
    const key = (item: string) => (item.startsWith('x') ? undefined : item);

    it('orders the items with a key, and the other items keep their index', () => {
        expect(orderInPlace(['a', 'x1', 'b', 'c'], key, ['c', 'a', 'b'])).toEqual(['c', 'x1', 'a', 'b']);
    });

    it('ignores the keys that are not in the list, and keeps the items that are not in the order', () => {
        expect(orderInPlace(['a', 'b', 'c'], key, ['z', 'c', 'a'])).toEqual(['c', 'b', 'a']);
    });

    it('returns the same list when nothing moves', () => {
        const list = ['a', 'x1', 'b'];
        expect(orderInPlace(list, key, ['a', 'b'])).toBe(list);
    });
});

describe('the order of a plan and its group', () => {
    const steps = [step('1', { repo: 'api', number: 1 }), step('2'), step('3', { repo: 'web', number: 2 }), step('4', { repo: 'api', number: 3 })];

    it('puts the pull requests of the group in the order of the plan', () => {
        const group = newGroup(1, 'g', [
            { repo: web, number: 2 },
            { repo: { owner: 'other', name: 'repo' }, number: 9 },
            { repo: api, number: 3 },
            { repo: api, number: 1 }
        ]);
        expect(groupInPlanOrder(group, { steps }).pullRequests.map(prKey)).toEqual(['octo/api#1', 'other/repo#9', 'octo/web#2', 'octo/api#3']);
    });

    it('puts the steps with a pull request in the order of the group', () => {
        const group = newGroup(1, 'g', [
            { repo: api, number: 3 },
            { repo: web, number: 2 },
            { repo: api, number: 1 }
        ]);
        expect(planInGroupOrder({ steps }, group).steps.map(item => item.id)).toEqual(['4', '2', '3', '1']);
    });

    it('returns the same objects when the orders match', () => {
        const plan = { steps };
        const group = newGroup(1, 'g', [
            { repo: api, number: 1 },
            { repo: web, number: 2 },
            { repo: api, number: 3 }
        ]);
        expect(planInGroupOrder(plan, group)).toBe(plan);
        expect(groupInPlanOrder(group, plan)).toBe(group);
    });
});

describe('stackLabels', () => {
    it('shows where each pull request of a stack merges, in the order of the stack', () => {
        const at = (id: string, repo: string, number: number, branch: string, base: string): PlanStep => ({
            ...newStep(`/code/${repo}`),
            id,
            branch,
            pr: { number, url: `https://github.com/octo/${repo}/pull/${number}`, base }
        });
        const labels = stackLabels({
            steps: [at('1', 'api', 41, 'p/1', 'main'), at('2', 'api', 42, 'p/2', 'p/1'), at('3', 'web', 7, 'p/1', 'main'), at('4', 'api', 43, 'p/3', 'p/2')]
        });
        expect([...labels.entries()]).toEqual([
            ['octo/api#41', 'Into main'],
            ['octo/api#42', 'Stacks on #41'],
            ['octo/web#7', 'Into main'],
            ['octo/api#43', 'Stacks on #42']
        ]);
    });
});
