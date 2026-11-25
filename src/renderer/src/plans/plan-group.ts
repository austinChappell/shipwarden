import { groupInPlanOrder, planInGroupOrder } from '@shared/plan-group-order';
import { movePullRequest, newGroup, parsePullRequestLink, prKey, withPullRequest, type GroupPullRequest, type PrGroup } from '@shared/pr-groups';
import type { Plan } from '@shared/plans';
import { cachedGroup, createGroup, loadGroups, updateGroup, useGroups } from '../github/pr-group-store';
import { cachedPlan, updatePlan } from './plan-queries';

/** The pull requests of the steps, in the order of the steps. */
export function planPullRequests(plan: Plan): GroupPullRequest[] {
    return plan.steps.flatMap(step => {
        const parsed = step.pr ? parsePullRequestLink(step.pr.url) : undefined;
        return parsed ? [{ ...parsed, title: step.title }] : [];
    });
}

/** The note that ShipWarden writes for the group of a plan: the source plan and the merge order. */
function planGroupNote(title: string, pullRequests: GroupPullRequest[]): string {
    return `The pull requests come from the plan "${title}". Merge them in this order: ${pullRequests.map(pr => prKey(pr)).join(', ')}.`;
}

/**
 * Returns `next` with the merge order of its pull requests in the note. A note that the user changed stays. `before` is
 * the group before the change: its note shows whether ShipWarden wrote the note.
 */
function withMergeOrderNote(before: PrGroup, next: PrGroup, planTitle: string): PrGroup {
    const autoNote = before.note === planGroupNote(planTitle, before.pullRequests);
    return autoNote ? { ...next, note: planGroupNote(planTitle, next.pullRequests) } : next;
}

/**
 * Returns the PR group of the plan with all pull requests of the plan. The group of an earlier call gets the new pull
 * requests. Without a group, a new group gets the title of the plan, and the merge order as its note. The group keeps
 * the ID of the plan in `planId`. This is the link between the plan and the group.
 */
export async function syncPlanGroup(plan: Plan, pullRequests = planPullRequests(plan)): Promise<PrGroup> {
    const existing = (await loadGroups()).find(group => group.planId === plan.id);
    if (existing) {
        const updated = await updateGroup(existing.id, current =>
            withMergeOrderNote(
                current,
                pullRequests.reduce((group, pr) => withPullRequest(group, pr), current),
                plan.title
            )
        );
        return updated ?? existing;
    }
    return createGroup({ ...newGroup(Date.now(), plan.title, pullRequests), planId: plan.id, note: planGroupNote(plan.title, pullRequests) });
}

/**
 * Gives the PR group of a plan the new title of the plan. The name and the note change only when ShipWarden wrote them.
 * A name or a note that the user changed stays.
 */
export async function renamePlanGroup(planId: string, before: string, after: string): Promise<void> {
    const group = (await loadGroups()).find(item => item.planId === planId);
    if (!group) return;
    await updateGroup(group.id, current => ({
        ...current,
        name: current.name === before ? after : current.name,
        note: current.note === planGroupNote(before, current.pullRequests) ? planGroupNote(after, current.pullRequests) : current.note
    }));
}

/** The PR group of the plan, or undefined. */
export function usePlanGroup(planId: string): PrGroup | undefined {
    const { groups } = useGroups();
    return groups.find(group => group.planId === planId);
}

/** Puts the pull requests of the PR group of the plan in the order of the steps of the plan. */
export async function syncGroupOrder(plan: Plan): Promise<void> {
    const group = (await loadGroups()).find(item => item.planId === plan.id);
    if (!group) return;
    await updateGroup(group.id, current => withMergeOrderNote(current, groupInPlanOrder(current, plan), plan.title));
}

/**
 * Moves a pull request of a group to the index `to`. When a plan made the group, the steps of the plan get the same
 * order as the pull requests.
 */
export async function moveGroupPullRequest(groupId: string, key: string, to: number): Promise<void> {
    const planId = cachedGroup(groupId)?.planId;
    const plan = planId ? cachedPlan(planId) : undefined;
    const group = await updateGroup(groupId, current => {
        const next = movePullRequest(current, key, to);
        return plan ? withMergeOrderNote(current, next, plan.title) : next;
    });
    if (group && plan) await updatePlan(plan.id, current => planInGroupOrder(current, group));
}
