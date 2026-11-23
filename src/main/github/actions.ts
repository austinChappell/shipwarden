import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanActionsLog, type CheckRun, type JobProgress, type RepoRef, type Workflow } from '@shared/github';
import type { PipelineApprovalItem } from '@shared/dashboard';
import type { WorkflowRun } from '@shared/pipelines';
import type { GitHubClient } from './github-client';
import {
    mapChecks,
    mapJobProgress,
    mapRunJob,
    markOldAttempts,
    mayBeOldAttempt,
    mapWorkflowRun,
    hasRepeatedJobs,
    type RestCheckRun,
    type RestJob,
    type RestRunJob,
    type RestStatus,
    type RestWorkflowRun,
    type RunAttempt
} from './actions-mapping';
import { parseWorkflowFile } from './workflow-file';

/** Returns the folder for the saved job logs. */
export function jobLogFolder(): string {
    return path.join(os.homedir(), '.shipwarden', 'ci-logs');
}

/**
 * Returns the check runs and the commit statuses of a commit.
 * A job that did not pass and that is from an older attempt of an active run shows as queued.
 * A job of a run that a newer run of the same workflow replaces shows as queued while the newer run is active.
 */
export async function fetchChecks(client: GitHubClient, repo: RepoRef, sha: string): Promise<CheckRun[]> {
    const base = `/repos/${repo.owner}/${repo.name}/commits/${sha}`;
    const [runs, statuses] = await Promise.all([
        client.paginate<RestCheckRun>(`${base}/check-runs`, page => (page as { check_runs: RestCheckRun[] }).check_runs, 500),
        client.rest<{ statuses: RestStatus[] }>('GET', `${base}/status`)
    ]);
    const checks = mapChecks(runs, statuses.statuses);
    // An old result is a job that did not pass, or a job of a run that a newer run replaces.
    // Without one of the two, the checks need no more requests.
    if (!checks.some(mayBeOldAttempt) && !hasRepeatedJobs(runs)) {
        return checks;
    }
    const attempts = await client.rest<{ workflow_runs: RunAttempt[] }>(
        'GET',
        `/repos/${repo.owner}/${repo.name}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`
    );
    return markOldAttempts(checks, attempts.workflow_runs);
}

/** The status of a job and its steps. It works while the job runs, also when the log is not ready. */
export async function fetchJobProgress(client: GitHubClient, repo: RepoRef, jobId: number): Promise<JobProgress> {
    return mapJobProgress(await client.rest<RestJob>('GET', `/repos/${repo.owner}/${repo.name}/actions/jobs/${jobId}`));
}

/** Returns the log of a job without the time stamps and the color codes. */
export async function fetchJobLog(client: GitHubClient, repo: RepoRef, jobId: number): Promise<string> {
    return cleanActionsLog(await client.text(`/repos/${repo.owner}/${repo.name}/actions/jobs/${jobId}/logs`, 'application/vnd.github+json'));
}

/** Saves the log of a job to a file, so that an agent can read the full log. Returns the file path. */
export async function saveJobLog(client: GitHubClient, repo: RepoRef, jobId: number, folder = jobLogFolder()): Promise<string> {
    await fs.mkdir(folder, { recursive: true });
    const file = path.join(folder, `${repo.owner}-${repo.name}-job-${jobId}.log`);
    await fs.writeFile(file, await fetchJobLog(client, repo, jobId));
    return file;
}

/** Lists the active workflows. A workflow is dispatchable when its file has a workflow_dispatch trigger. */
export async function fetchWorkflows(client: GitHubClient, repo: RepoRef, ref: string): Promise<Workflow[]> {
    const list = await client.paginate<{ id: number; name: string; path: string; state: string }>(
        `/repos/${repo.owner}/${repo.name}/actions/workflows`,
        page => (page as { workflows: { id: number; name: string; path: string; state: string }[] }).workflows
    );
    const active = list.filter(workflow => workflow.state === 'active' && workflow.path.startsWith('.github/workflows/'));
    return Promise.all(
        active.map(async workflow => {
            let trigger = { dispatchable: false, inputs: [] as Workflow['inputs'] };
            try {
                trigger = parseWorkflowFile(await client.text(`/repos/${repo.owner}/${repo.name}/contents/${workflow.path}?ref=${encodeURIComponent(ref)}`));
            } catch {
                // The workflow file is not on this branch.
            }
            return { id: workflow.id, name: workflow.name, path: workflow.path, ...trigger };
        })
    );
}

/** Starts a workflow with a `workflow_dispatch` trigger on a branch or tag, with the values of its inputs. */
export async function dispatchWorkflow(client: GitHubClient, repo: RepoRef, workflowId: number, ref: string, inputs?: Record<string, string>): Promise<void> {
    await client.rest('POST', `/repos/${repo.owner}/${repo.name}/actions/workflows/${workflowId}/dispatches`, {
        ref,
        ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {})
    });
}

/** Returns the newest workflow runs of a repository, of one workflow when `workflowId` is set. */
export async function fetchWorkflowRuns(client: GitHubClient, repo: RepoRef, workflowId?: number): Promise<WorkflowRun[]> {
    const base = workflowId ? `/repos/${repo.owner}/${repo.name}/actions/workflows/${workflowId}/runs` : `/repos/${repo.owner}/${repo.name}/actions/runs`;
    const data = await client.rest<{ workflow_runs: RestWorkflowRun[] }>('GET', `${base}?per_page=40`);
    return data.workflow_runs.map(mapWorkflowRun);
}

/** Returns the jobs of the latest attempt of a run, as check runs, so the log view can show their logs. */
export async function fetchRunJobs(client: GitHubClient, repo: RepoRef, runId: number): Promise<CheckRun[]> {
    const jobs = await client.paginate<RestRunJob>(
        `/repos/${repo.owner}/${repo.name}/actions/runs/${runId}/jobs?filter=latest`,
        page => (page as { jobs: never[] }).jobs
    );
    return jobs.map(mapRunJob);
}

/** Runs one job again. */
export async function rerunJob(client: GitHubClient, repo: RepoRef, jobId: number): Promise<void> {
    await client.rest('POST', `/repos/${repo.owner}/${repo.name}/actions/jobs/${jobId}/rerun`);
}

/** Runs the failed jobs of a run again. */
export async function rerunFailedJobs(client: GitHubClient, repo: RepoRef, runId: number): Promise<void> {
    await client.rest('POST', `/repos/${repo.owner}/${repo.name}/actions/runs/${runId}/rerun-failed-jobs`);
}

/** Runs all jobs of a finished run again. */
export async function rerunRun(client: GitHubClient, repo: RepoRef, runId: number): Promise<void> {
    await client.rest('POST', `/repos/${repo.owner}/${repo.name}/actions/runs/${runId}/rerun`);
}

/** Stops a run that is in progress. */
export async function cancelRun(client: GitHubClient, repo: RepoRef, runId: number): Promise<void> {
    await client.rest('POST', `/repos/${repo.owner}/${repo.name}/actions/runs/${runId}/cancel`);
}

/** A deployment of a run that waits for a review. GitHub returns it from "pending_deployments". */
interface RestPendingDeployment {
    environment: { id: number; name?: string };
    current_user_can_approve: boolean;
}

/** The largest number of waiting runs of a repository that the Dashboard reads. Each run needs one more request. */
const WAITING_RUNS_LIMIT = 10;

/**
 * Returns the runs of a repository that wait for the approval of the user: deployments to environments with required
 * reviewers, where the user is one of the reviewers. Only the latest run of a workflow counts. When a newer run of the
 * workflow exists, the older run gives no item. A repository without a waiting run costs one request.
 */
export async function fetchPendingApprovals(client: GitHubClient, repo: RepoRef): Promise<PipelineApprovalItem[]> {
    const base = `/repos/${repo.owner}/${repo.name}/actions/runs`;
    const data = await client.rest<{ workflow_runs: RestWorkflowRun[] }>('GET', `${base}?status=waiting&per_page=${WAITING_RUNS_LIMIT}`);
    // Keep the newest waiting run of each workflow. A larger run ID is a newer run.
    const newest = new Map<number, RestWorkflowRun>();
    for (const run of data.workflow_runs) {
        const kept = newest.get(run.workflow_id);
        if (!kept || run.id > kept.id) newest.set(run.workflow_id, run);
    }
    const items = await Promise.all(
        [...newest.values()].map(async (run): Promise<PipelineApprovalItem | undefined> => {
            if (!(await isLatestRun(client, repo, run))) return undefined;
            const pending = await client.rest<RestPendingDeployment[]>('GET', `${base}/${run.id}/pending_deployments`);
            const approvable = pending.filter(item => item.current_user_can_approve);
            if (approvable.length === 0) return undefined;
            return {
                id: `github:${repo.owner}/${repo.name}:${run.id}`,
                source: repo.name,
                sourceTitle: `${repo.owner}/${repo.name}`,
                workflow: run.name ?? 'Workflow',
                title: run.display_title ?? run.name ?? `Run ${run.run_number}`,
                environments: approvable.map(item => item.environment.name ?? String(item.environment.id)),
                branch: run.head_branch ?? undefined,
                actor: (run.triggering_actor ?? run.actor)?.login,
                url: run.html_url,
                createdAt: run.created_at,
                target: {
                    kind: 'github',
                    repo: { owner: repo.owner, name: repo.name },
                    runId: run.id,
                    environmentIds: approvable.map(item => item.environment.id)
                }
            };
        })
    );
    return items.filter((item): item is PipelineApprovalItem => !!item);
}

/** Returns true when no newer run of the workflow of the run exists. When the request fails, it returns true. */
async function isLatestRun(client: GitHubClient, repo: RepoRef, run: RestWorkflowRun): Promise<boolean> {
    const data = await client
        .rest<{ workflow_runs: RestWorkflowRun[] }>('GET', `/repos/${repo.owner}/${repo.name}/actions/workflows/${run.workflow_id}/runs?per_page=1`)
        .catch(() => undefined);
    const latest = data?.workflow_runs?.[0];
    return !latest || latest.id <= run.id;
}

/** Approves the deployments of a waiting run to the environments. The run then continues. */
export async function approveDeployments(client: GitHubClient, repo: RepoRef, runId: number, environmentIds: number[]): Promise<void> {
    // GitHub needs the comment field. An empty comment is valid.
    await client.rest('POST', `/repos/${repo.owner}/${repo.name}/actions/runs/${runId}/pending_deployments`, {
        environment_ids: environmentIds,
        state: 'approved',
        comment: ''
    });
}
