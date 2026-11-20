import type { BranchSummary } from './github';
import type { Plan, PlanStep } from './plans';

/**
 * The progress of a plan after it started: the state of each step and of its pull request. The page of a running plan
 * groups the steps by these states, and finds the next pull request to merge.
 *
 * The functions of this module use no Electron API and no browser API.
 */

/** The review state of an open pull request. "unknown": the pull requests of the repository did not load yet. */
export type StepReview = 'approved' | 'changes' | 'awaiting' | 'draft' | 'unknown';

/** The state of the checks on the head commit of an open pull request. */
export type StepChecks = 'passing' | 'failing' | 'pending' | 'none';

/**
 * The group of a step for the status bar of the page. Each step is in one group.
 * - "merged": the pull request is merged.
 * - "ready": the pull request is approved and its checks pass.
 * - "review": the pull request waits for a review or for its checks.
 * - "changes": a reviewer asks for changes.
 * - "failing": a check fails.
 * - "working": the agent is working on the step.
 * - "needs-you": the step stopped or failed, and it needs the user.
 * - "pending": the step did not start.
 * - "closed": the pull request was closed without a merge.
 * - "done": the step is done and has no pull request, for example an experiment.
 * - "skipped": the plan does not run the step.
 */
export type ProgressGroup = 'merged' | 'ready' | 'review' | 'changes' | 'failing' | 'working' | 'needs-you' | 'pending' | 'closed' | 'done' | 'skipped';

export interface StepProgress {
    group: ProgressGroup;
    /** Only for an open pull request. */
    review?: StepReview;
    /** Only for an open pull request. */
    checks?: StepChecks;
    /** The head commit of the open pull request, from the summary. */
    headSha?: string;
}

/** The order of the groups in the status bar and in its legend. */
export const PROGRESS_GROUPS: readonly ProgressGroup[] = [
    'merged',
    'ready',
    'review',
    'changes',
    'failing',
    'working',
    'needs-you',
    'pending',
    'closed',
    'done',
    'skipped'
];

export const PROGRESS_LABELS: Record<ProgressGroup, string> = {
    merged: 'merged',
    ready: 'ready to merge',
    review: 'in review',
    changes: 'changes requested',
    failing: 'checks failing',
    working: 'agent working',
    'needs-you': 'needs you',
    pending: 'not started',
    closed: 'closed',
    done: 'done without a PR',
    skipped: 'skipped'
};

/** The pull request data of one repository: the open pull requests by head branch, and the merged ones by branch. */
export interface RepoPullRequests {
    /** Undefined: the open pull requests did not load yet. */
    open?: Record<string, BranchSummary>;
    merged?: Record<string, { number: number }>;
}

/** The most open pull requests that one load of the branch summaries returns. A longer list is cut. */
export const MAX_OPEN_SUMMARIES = 100;

/**
 * True when the list has all open pull requests of the repository. An empty list can come from a repository without
 * access, and a list at the maximum can be cut. Thus a pull request that is not in such a list is not known to be closed.
 */
function listIsComplete(open: Record<string, BranchSummary> | undefined): boolean {
    const count = open ? Object.keys(open).length : 0;
    return count > 0 && count < MAX_OPEN_SUMMARIES;
}

/**
 * True when the open pull requests of the repository are all known and the pull request of the step is not one of
 * them: it merged or it was closed. False when the step has no pull request or when the list can be incomplete.
 */
export function pullRequestKnownClosed(step: Pick<PlanStep, 'pr' | 'branch'>, open: Record<string, BranchSummary> | undefined): boolean {
    if (!step.pr || !step.branch || !listIsComplete(open)) return false;
    return open?.[step.branch]?.number !== step.pr.number;
}

function checksOf(state: string | null): StepChecks {
    if (state === 'SUCCESS') return 'passing';
    if (state === 'FAILURE' || state === 'ERROR') return 'failing';
    if (state === 'PENDING' || state === 'EXPECTED') return 'pending';
    return 'none';
}

function reviewOf(summary: BranchSummary): StepReview {
    if (summary.isDraft) return 'draft';
    if (summary.reviewDecision === 'APPROVED') return 'approved';
    if (summary.reviewDecision === 'CHANGES_REQUESTED') return 'changes';
    return 'awaiting';
}

/** Returns the progress of one step. `data` is the pull request data of the repository of the step. */
export function stepProgress(step: PlanStep, data: RepoPullRequests | undefined): StepProgress {
    if (step.status === 'skipped' || step.skip) return { group: 'skipped' };
    if (step.status === 'pending') return { group: 'pending' };
    if (step.status === 'running') return { group: 'working' };
    if (step.status === 'attention' || step.status === 'failed') return { group: 'needs-you' };
    // The step is done.
    if (!step.pr || !step.branch) return { group: 'done' };
    if (data?.merged?.[step.branch]?.number === step.pr.number) return { group: 'merged' };
    const summary = data?.open?.[step.branch];
    if (!summary || summary.number !== step.pr.number) {
        // A full list of the open pull requests without this one: it was closed. A merge can show a little later.
        return listIsComplete(data?.open) ? { group: 'closed' } : { group: 'review', review: 'unknown', checks: 'none' };
    }
    const review = reviewOf(summary);
    const checks = checksOf(summary.checks);
    const base = { review, checks, ...(summary.headSha ? { headSha: summary.headSha } : {}) };
    if (checks === 'failing') return { group: 'failing', ...base };
    if (review === 'changes') return { group: 'changes', ...base };
    if (review === 'approved' && checks !== 'pending') return { group: 'ready', ...base };
    return { group: 'review', ...base };
}

/**
 * Returns the step that the pull request of the step at `index` waits for: the nearest earlier step in the same
 * repository with a pull request that is not merged. Undefined: the pull request can merge now.
 */
export function blockingStep(plan: Pick<Plan, 'steps'>, progress: readonly StepProgress[], index: number): number | undefined {
    const repo = plan.steps[index]?.repo;
    for (let at = index - 1; at >= 0; at--) {
        const step = plan.steps[at];
        if (step.repo !== repo || !step.pr) continue;
        if (progress[at].group !== 'merged') return at;
    }
    return undefined;
}

/** Returns the indexes of the steps whose pull requests can merge now: ready, and no earlier pull request blocks them. */
export function mergeableSteps(plan: Pick<Plan, 'steps'>, progress: readonly StepProgress[]): number[] {
    return plan.steps.flatMap((_, index) => (progress[index].group === 'ready' && blockingStep(plan, progress, index) === undefined ? [index] : []));
}

/** Counts the steps of each group. */
export function progressCounts(progress: readonly StepProgress[]): Record<ProgressGroup, number> {
    const counts = Object.fromEntries(PROGRESS_GROUPS.map(group => [group, 0])) as Record<ProgressGroup, number>;
    for (const item of progress) counts[item.group]++;
    return counts;
}

/** True when each step that opened a pull request is merged, and no step is still to do. */
export function planShipped(progress: readonly StepProgress[]): boolean {
    const open = progress.filter(item => item.group !== 'skipped' && item.group !== 'done' && item.group !== 'closed');
    return open.length > 0 && open.every(item => item.group === 'merged');
}
