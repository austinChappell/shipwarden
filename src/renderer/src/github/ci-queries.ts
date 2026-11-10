import { queryOptions, useMutation } from '@tanstack/react-query';
import { targetKey, type CheckConclusion, type CheckRun, type RepoTarget, type Workflow } from '@shared/github';
import { runIsActive, type WorkflowRun } from '@shared/pipelines';
import { keyRoots, queryClient, STALE_MS } from '../query-client';

/** The conclusions of a failed check, job or step. */
const FAILED = new Set<string>(['failure', 'timed_out', 'cancelled', 'action_required', 'error']);

/** True when the conclusion is a failure. */
export function isFailedConclusion(conclusion: CheckConclusion | string | null | undefined): boolean {
    return FAILED.has(conclusion ?? '');
}

/** The key part for a repository target. Null when there is no target. */
const part = (target: RepoTarget | undefined) => (target === undefined ? null : targetKey(target));

/** The query keys of the CI data. Each key starts with a root of `keyRoots`. */
export const ciKeys = {
    /** All checks of a repository. */
    checksOf: (target: RepoTarget) => [...keyRoots.checks, targetKey(target)],
    checks: (target: RepoTarget, sha: string | undefined) => [...keyRoots.checks, targetKey(target), sha ?? null],
    branches: (target: RepoTarget | undefined) => [...keyRoots.branches, part(target)],
    workflows: (target: RepoTarget | undefined, ref: string | undefined) => [...keyRoots.workflows, part(target), ref ?? null],
    /** All workflow runs of a repository, for all workflows. */
    workflowRunsOf: (target: RepoTarget) => [...keyRoots.workflowRuns, targetKey(target)],
    workflowRuns: (target: RepoTarget | undefined, workflowId: number | undefined) => [...keyRoots.workflowRuns, part(target), workflowId ?? null],
    /** All run jobs of a repository, for all runs. */
    runJobsOf: (target: RepoTarget) => [...keyRoots.runJobs, targetKey(target)],
    runJobs: (target: RepoTarget | undefined, runId: number | undefined) => [...keyRoots.runJobs, part(target), runId ?? null],
    jobLog: (target: RepoTarget, jobId: number) => [...keyRoots.jobLog, targetKey(target), jobId],
    jobProgress: (target: RepoTarget, jobId: number) => [...keyRoots.jobLog, targetKey(target), jobId, 'progress']
};

/** Returns the fast interval while the data is live, else the default interval. */
export function liveInterval(live: boolean, fastMs: number): number {
    return live ? fastMs : STALE_MS;
}

/** True while a check or job waits or runs. */
export function checksRunning(checks: readonly Pick<CheckRun, 'status'>[] | undefined): boolean {
    return !!checks?.some(check => check.status !== 'completed');
}

/** True while a run waits or runs. */
export function runsActive(runs: readonly Pick<WorkflowRun, 'status'>[] | undefined): boolean {
    return !!runs?.some(runIsActive);
}

/** Sorts the workflows by name. A query `select` uses it. */
export function sortWorkflows(workflows: Workflow[]): Workflow[] {
    return [...workflows].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The repositories of the review providers. Another set of providers (`reviewKey`) gives other repositories.
 * The Review view uses the same key, so the two views share one request.
 */
export function repositoriesQuery(reviewKey: string | null) {
    return queryOptions({
        queryKey: [...keyRoots.repositories, reviewKey],
        queryFn: () => window.shipwarden.github.repositories()
    });
}

/** The branches of a repository. The default branch is first. */
export function branchesQuery(target: RepoTarget | undefined) {
    return queryOptions({
        queryKey: ciKeys.branches(target),
        queryFn: () => window.shipwarden.github.branches(target as RepoTarget),
        enabled: target !== undefined
    });
}

/** The workflows of a repository on a branch. The query waits for the branch. */
export function workflowsQuery(target: RepoTarget | undefined, ref: string | undefined) {
    return queryOptions({
        queryKey: ciKeys.workflows(target, ref),
        queryFn: () => window.shipwarden.github.workflows(target as RepoTarget, ref as string),
        enabled: target !== undefined && ref !== undefined
    });
}

/**
 * The checks of a commit. The Checks panel and the check counts use the same key.
 * The checks are live data: they load again at the fast interval while a check waits or runs.
 */
export function checksQuery(target: RepoTarget, sha: string | undefined, fastMs: number) {
    return queryOptions({
        queryKey: ciKeys.checks(target, sha),
        queryFn: () => window.shipwarden.github.checks(target, sha as string),
        enabled: !!sha,
        refetchInterval: query => liveInterval(checksRunning(query.state.data), fastMs)
    });
}

/**
 * The newest runs of a repository, of one workflow or of all workflows.
 * The runs are live data: they load again at the fast interval while a run waits or runs.
 */
export function workflowRunsQuery(target: RepoTarget | undefined, workflowId: number | undefined, fastMs: number) {
    return queryOptions({
        queryKey: ciKeys.workflowRuns(target, workflowId),
        queryFn: () => window.shipwarden.github.workflowRuns(target as RepoTarget, workflowId),
        enabled: target !== undefined,
        refetchInterval: query => liveInterval(runsActive(query.state.data), fastMs)
    });
}

/**
 * The jobs of a run. The jobs are live data: they load again at the fast interval while the run or a job waits or
 * runs. A queued run can have no jobs yet, so the state of the run counts too.
 */
export function runJobsQuery(target: RepoTarget | undefined, runId: number | undefined, runActive: boolean, fastMs: number) {
    return queryOptions({
        queryKey: ciKeys.runJobs(target, runId),
        queryFn: () => window.shipwarden.github.runJobs(target as RepoTarget, runId as number),
        enabled: target !== undefined && runId !== undefined,
        refetchInterval: query => liveInterval(runActive || checksRunning(query.state.data), fastMs)
    });
}

// The pure cache patches. Each patch returns the same list when it changes nothing.

/** Applies the change to the items that match. */
function patchItems<T>(items: T[], match: (item: T) => boolean, change: (item: T) => T): T[] {
    if (!items.some(match)) return items;
    return items.map(item => (match(item) ? change(item) : item));
}

/** Marks the run as queued, as after a rerun. */
export function queueRun(runs: WorkflowRun[], runId: number, now: string): WorkflowRun[] {
    return patchItems(
        runs,
        run => run.id === runId,
        run => ({ ...run, status: 'queued', conclusion: null, updatedAt: now })
    );
}

/** Marks the run as cancelled, as after a cancel. */
export function cancelRunIn(runs: WorkflowRun[], runId: number, now: string): WorkflowRun[] {
    return patchItems(
        runs,
        run => run.id === runId && runIsActive(run),
        run => ({ ...run, status: 'completed', conclusion: 'cancelled', updatedAt: now })
    );
}

/** Marks the checks or jobs that match as queued, as after a rerun. */
export function queueChecks(checks: CheckRun[], match: (check: CheckRun) => boolean): CheckRun[] {
    return patchItems(checks, match, check => ({ ...check, status: 'queued', conclusion: null, startedAt: null, completedAt: null }));
}

/** Marks the checks or jobs that match and do not complete as cancelled, as after a cancel. */
export function cancelChecks(checks: CheckRun[], match: (check: CheckRun) => boolean, now: string): CheckRun[] {
    return patchItems(
        checks,
        check => match(check) && check.status !== 'completed',
        check => ({ ...check, status: 'completed', conclusion: 'cancelled', completedAt: now })
    );
}

/** True for a check or job that failed. */
const failed = (check: CheckRun) => isFailedConclusion(check.conclusion);

// The cache updates after a CI action. They change the cached data and do not send requests.
// A queued run or job is live data, so its query loads the real state at the fast interval.

function patchRuns(target: RepoTarget, update: (runs: WorkflowRun[]) => WorkflowRun[]): void {
    queryClient.setQueriesData<WorkflowRun[]>({ queryKey: ciKeys.workflowRunsOf(target) }, runs => runs && update(runs));
}

function patchJobs(target: RepoTarget, runId: number | undefined, update: (jobs: CheckRun[]) => CheckRun[]): void {
    const queryKey = runId === undefined ? ciKeys.runJobsOf(target) : ciKeys.runJobs(target, runId);
    queryClient.setQueriesData<CheckRun[]>({ queryKey }, jobs => jobs && update(jobs));
}

function patchChecks(target: RepoTarget, update: (checks: CheckRun[]) => CheckRun[]): void {
    queryClient.setQueriesData<CheckRun[]>({ queryKey: ciKeys.checksOf(target) }, checks => checks && update(checks));
}

/** The delays after a dispatch. The host makes the new run a few seconds after the dispatch. */
const DISPATCH_REFRESH_MS = [2500, 7000];

/**
 * The CI actions. Each action sends the request and then updates the cached data.
 * The hosts do not return the new state, so the update sets the state that the action gives.
 */
export const ciActions = {
    async cancelRun(target: RepoTarget, runId: number): Promise<void> {
        await window.shipwarden.github.cancelRun(target, runId);
        const now = new Date().toISOString();
        patchRuns(target, runs => cancelRunIn(runs, runId, now));
        patchJobs(target, runId, jobs => cancelChecks(jobs, () => true, now));
        patchChecks(target, checks => cancelChecks(checks, check => check.runId === runId, now));
    },

    async rerunRun(target: RepoTarget, runId: number): Promise<void> {
        await window.shipwarden.github.rerunRun(target, runId);
        // On Azure DevOps, a rerun makes a new build. The queued run loads the runs again at the fast interval,
        // and that load gets the new build.
        patchRuns(target, runs => queueRun(runs, runId, new Date().toISOString()));
        patchJobs(target, runId, jobs => queueChecks(jobs, () => true));
        patchChecks(target, checks => queueChecks(checks, check => check.runId === runId));
    },

    async rerunFailedJobs(target: RepoTarget, runId: number): Promise<void> {
        await window.shipwarden.github.rerunFailedJobs(target, runId);
        patchRuns(target, runs => queueRun(runs, runId, new Date().toISOString()));
        patchJobs(target, runId, jobs => queueChecks(jobs, failed));
        patchChecks(target, checks => queueChecks(checks, check => check.runId === runId && failed(check)));
    },

    /** Runs one job again. The run ID is optional. Without it, the run of the job keeps its cached state. */
    async rerunJob(target: RepoTarget, jobId: number, runId?: number): Promise<void> {
        await window.shipwarden.github.rerunJob(target, jobId);
        if (runId !== undefined) patchRuns(target, runs => queueRun(runs, runId, new Date().toISOString()));
        patchJobs(target, runId, jobs => queueChecks(jobs, job => job.id === jobId));
        patchChecks(target, checks => queueChecks(checks, check => check.id === jobId));
    },

    /** Starts a workflow. The ID of the new run is not known, so the runs and checks of the repository load again. */
    async dispatchWorkflow(target: RepoTarget, workflowId: number, ref: string, inputs?: Record<string, string>): Promise<void> {
        await window.shipwarden.github.dispatchWorkflow(target, workflowId, ref, inputs);
        for (const delay of DISPATCH_REFRESH_MS) {
            setTimeout(() => {
                void queryClient.invalidateQueries({ queryKey: ciKeys.workflowRunsOf(target) });
                void queryClient.invalidateQueries({ queryKey: ciKeys.checksOf(target) });
            }, delay);
        }
    }
};

/**
 * A mutation for a CI action from `ciActions`. It gives the busy state and the error of the action.
 * Call `mutate` with a function that calls the action.
 */
export function useCiAction() {
    return useMutation({ mutationFn: (action: () => Promise<void>) => action() });
}
