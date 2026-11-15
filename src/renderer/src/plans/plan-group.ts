import { newGroup, parsePullRequestLink, prKey, withPullRequest, type GroupPullRequest, type PrGroup } from '@shared/pr-groups';
import type { Plan } from '@shared/plans';
import { createGroup, loadGroups, updateGroup, useGroups } from '../github/pr-group-store';

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
 * Returns the PR group of the plan with all pull requests of the plan. The group of an earlier call gets the new pull
 * requests. Without a group, a new group gets the title of the plan, and the merge order as its note. The group keeps
 * the ID of the plan in `planId`. This is the link between the plan and the group.
 */
export async function syncPlanGroup(plan: Plan, pullRequests = planPullRequests(plan)): Promise<PrGroup> {
    const existing = (await loadGroups()).find(group => group.planId === plan.id);
    if (existing) {
        const updated = await updateGroup(existing.id, current => {
            const next = pullRequests.reduce((group, pr) => withPullRequest(group, pr), current);
            // The merge order in the note gets the new pull requests. A note that the user changed stays.
            const autoNote = current.note === planGroupNote(plan.title, current.pullRequests);
            return autoNote ? { ...next, note: planGroupNote(plan.title, next.pullRequests) } : next;
        });
        return updated ?? existing;
    }
    return createGroup({ ...newGroup(Date.now(), plan.title, pullRequests), planId: plan.id, note: planGroupNote(plan.title, pullRequests) });
}

/** The PR group of the plan, or undefined. */
export function usePlanGroup(planId: string): PrGroup | undefined {
    const { groups } = useGroups();
    return groups.find(group => group.planId === planId);
}
