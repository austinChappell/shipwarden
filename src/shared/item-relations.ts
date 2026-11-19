import type { RepoRef } from './github';
import type { Plan, PlanStep } from './plans';
import { parsePullRequestLink, prKey, type PrGroup } from './pr-groups';
import { linkMatchesTask, type TaskLink } from './tasks';

/**
 * The links between the items of ShipWarden. A worktree works on a task and opens a pull request. A plan step has a
 * worktree, a task and a pull request. A PR group has pull requests, and a plan can have a group. These functions find
 * the items that link to one item.
 *
 * The functions of this module use no Electron API and no browser API.
 */

/** A pull request by its repository and number. */
export interface PullRequestRef {
    repo: RepoRef;
    number: number;
}

/** A task of a connection. */
export interface TaskRef {
    connectionId: string;
    id: string;
    url?: string;
}

/** The known parts of one item. Each part can find the plan of the item. */
export interface ItemAnchor {
    worktreePath?: string;
    pullRequest?: PullRequestRef;
    task?: TaskRef;
}

/** True when the two pull requests are the same. The names of GitHub repositories are not case sensitive. */
export function samePullRequest(a: PullRequestRef, b: PullRequestRef): boolean {
    return prKey(a).toLowerCase() === prKey(b).toLowerCase();
}

/** The pull request of a step, from its address. */
export function stepPullRequest(step: PlanStep): PullRequestRef | undefined {
    return step.pr ? parsePullRequestLink(step.pr.url) : undefined;
}

/** The task link of a step, when the step works on a task. */
export function stepTaskLink(step: PlanStep): TaskLink | undefined {
    return step.task.kind === 'existing' ? step.task.link : undefined;
}

function stepMatches(step: PlanStep, anchor: ItemAnchor): boolean {
    if (anchor.worktreePath && step.worktreePath === anchor.worktreePath) return true;
    const pr = anchor.pullRequest && stepPullRequest(step);
    if (pr && anchor.pullRequest && samePullRequest(pr, anchor.pullRequest)) return true;
    const link = anchor.task && stepTaskLink(step);
    return !!link && !!anchor.task && linkMatchesTask(link, anchor.task.connectionId, anchor.task);
}

/** Returns the plan and the step that have the worktree, the pull request or the task of the anchor. The newest plan comes first. */
export function planStepOf(plans: readonly Plan[], anchor: ItemAnchor): { plan: Plan; step: PlanStep } | undefined {
    if (!anchor.worktreePath && !anchor.pullRequest && !anchor.task) return undefined;
    for (const plan of plans) {
        const step = plan.steps.find(item => stepMatches(item, anchor));
        if (step) return { plan, step };
    }
    return undefined;
}

/** Returns the groups that have the pull request, and the group of the plan. Each group shows one time. */
export function groupsOf(groups: readonly PrGroup[], pullRequest: PullRequestRef | undefined, planId: string | undefined): PrGroup[] {
    return groups.filter(
        group => (!!planId && group.planId === planId) || (!!pullRequest && group.pullRequests.some(item => samePullRequest(item, pullRequest)))
    );
}

/** Returns the worktree that has a link to the task, by the task links of the worktrees. */
export function worktreeOfTask(links: Record<string, TaskLink>, task: TaskRef): string | undefined {
    return Object.entries(links).find(([, link]) => linkMatchesTask(link, task.connectionId, task))?.[0];
}
