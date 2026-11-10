import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanActionsLog, type CheckRun, type JobProgress, type RepoRef, type Workflow } from '@shared/github';
import type { WorkflowRun } from '@shared/pipelines';
import type { GitHubClient } from './github-client';
import {
    mapChecks,
    mapJobProgress,
    mapRunJob,
    mapWorkflowRun,
    type RestCheckRun,
    type RestJob,
    type RestRunJob,
    type RestStatus,
    type RestWorkflowRun
} from './actions-mapping';
import { parseWorkflowFile } from './workflow-file';

/** Returns the folder for the saved job logs. */
export function jobLogFolder(): string {
    return path.join(os.homedir(), '.shipwarden', 'ci-logs');
}

/** Returns the check runs and the commit statuses of a commit. */
export async function fetchChecks(client: GitHubClient, repo: RepoRef, sha: string): Promise<CheckRun[]> {
    const base = `/repos/${repo.owner}/${repo.name}/commits/${sha}`;
    const [runs, statuses] = await Promise.all([
        client.paginate<RestCheckRun>(`${base}/check-runs`, page => (page as { check_runs: RestCheckRun[] }).check_runs, 500),
        client.rest<{ statuses: RestStatus[] }>('GET', `${base}/status`)
    ]);
    return mapChecks(runs, statuses.statuses);
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
    return Promise.all(active.map(async workflow => {
        let trigger = { dispatchable: false, inputs: [] as Workflow['inputs'] };
        try {
            trigger = parseWorkflowFile(await client.text(`/repos/${repo.owner}/${repo.name}/contents/${workflow.path}?ref=${encodeURIComponent(ref)}`));
        } catch {
            // The workflow file is not on this branch.
        }
        return { id: workflow.id, name: workflow.name, path: workflow.path, ...trigger };
    }));
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
    const base = workflowId
        ? `/repos/${repo.owner}/${repo.name}/actions/workflows/${workflowId}/runs`
        : `/repos/${repo.owner}/${repo.name}/actions/runs`;
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
