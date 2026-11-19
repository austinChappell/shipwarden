import type { Plan, PlanStep } from './plans';
import { parsePullRequestLink, prKey, type PrGroup } from './pr-groups';

/**
 * The order of a plan and the order of its PR group stay the same. A move in one of them moves the same pull request in
 * the other one. The steps without a pull request, and the pull requests that are not in the plan, keep their places.
 *
 * The functions of this module use no Electron API and no browser API.
 */

/** Returns the key of the pull request of a step, in lowercase, or undefined. */
export function stepPrKey(step: PlanStep): string | undefined {
    const link = step.pr ? parsePullRequestLink(step.pr.url) : undefined;
    return link ? prKey(link).toLowerCase() : undefined;
}

/**
 * Returns a copy of `list` where the items with a key in `order` are in the sequence of `order`. Each of these items
 * goes into the place of one of them, so all other items keep their index. Returns the same list when nothing moves.
 */
export function orderInPlace<T>(list: readonly T[], keyOf: (item: T) => string | undefined, order: readonly string[]): readonly T[] {
    const present = new Map<string, T>();
    for (const item of list) {
        const key = keyOf(item);
        if (key !== undefined) present.set(key, item);
    }
    const wanted = order.filter(key => present.has(key));
    const inWanted = new Set(wanted);
    let next = 0;
    let changed = false;
    const result = list.map(item => {
        const key = keyOf(item);
        if (key === undefined || !inWanted.has(key)) return item;
        const placed = present.get(wanted[next++]) as T;
        if (placed !== item) changed = true;
        return placed;
    });
    return changed ? result : list;
}

/** Returns the group with the pull requests of the plan in the order of the steps of the plan. */
export function groupInPlanOrder(group: PrGroup, plan: Pick<Plan, 'steps'>): PrGroup {
    const order = plan.steps.flatMap(step => stepPrKey(step) ?? []);
    const pullRequests = orderInPlace(group.pullRequests, pr => prKey(pr).toLowerCase(), order);
    return pullRequests === group.pullRequests ? group : { ...group, pullRequests: [...pullRequests] };
}

/** Returns the plan with the steps that have a pull request in the order of the pull requests of the group. */
export function planInGroupOrder<P extends Pick<Plan, 'steps'>>(plan: P, group: Pick<PrGroup, 'pullRequests'>): P {
    const order = group.pullRequests.map(pr => prKey(pr).toLowerCase());
    const steps = orderInPlace(plan.steps, stepPrKey, order);
    return steps === plan.steps ? plan : { ...plan, steps: [...steps] };
}
