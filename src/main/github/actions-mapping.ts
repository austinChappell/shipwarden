import {
    latestChecks,
    parseActionsRunId,
    type CheckConclusion,
    type CheckRun,
    type CheckStatus,
    type JobProgress
} from '@shared/github';
import type { WorkflowRun } from '@shared/pipelines';

export interface RestCheckRun {
    id: number;
    name: string;
    status: CheckStatus;
    conclusion: CheckConclusion;
    started_at: string | null;
    completed_at: string | null;
    details_url: string | null;
    html_url: string | null;
    app?: { slug?: string };
}

export interface RestStatus {
    id: number;
    context: string;
    state: 'success' | 'failure' | 'error' | 'pending';
    target_url: string | null;
    created_at: string;
    updated_at: string;
}

export interface RestStep {
    number: number;
    name: string;
    status: CheckStatus;
    conclusion: CheckConclusion;
    started_at: string | null;
    completed_at: string | null;
}

export interface RestJob {
    status: CheckStatus;
    conclusion: CheckConclusion;
    started_at: string | null;
    completed_at: string | null;
    steps?: RestStep[];
}

/** A job in the job list of a workflow run. */
export interface RestRunJob {
    id: number;
    name: string;
    status: CheckStatus;
    conclusion: CheckConclusion;
    started_at: string | null;
    completed_at: string | null;
    html_url: string | null;
    run_id: number;
}

export interface RestWorkflowRun {
    id: number;
    name: string | null;
    display_title?: string;
    workflow_id: number;
    run_number: number;
    head_branch: string | null;
    head_sha: string;
    event: string;
    status: string | null;
    conclusion: string | null;
    actor?: { login: string } | null;
    triggering_actor?: { login: string } | null;
    created_at: string;
    updated_at: string;
    run_started_at?: string;
    html_url: string;
}

/** Changes a check run to the shared type. Only a GitHub Actions check gets a run ID. */
export function mapCheckRun(run: RestCheckRun): CheckRun {
    const isActions = run.app?.slug === 'github-actions';
    return {
        id: run.id,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        startedAt: run.started_at,
        completedAt: run.completed_at,
        url: run.html_url ?? run.details_url,
        isActions,
        runId: isActions ? parseActionsRunId(run.details_url) : undefined
    };
}

/** Changes a commit status to a check. A pending status has no conclusion and no end time. */
export function mapCommitStatus(status: RestStatus): CheckRun {
    return {
        id: status.id,
        name: status.context,
        status: status.state === 'pending' ? 'pending' : 'completed',
        conclusion: status.state === 'pending' ? null : status.state,
        startedAt: status.created_at,
        completedAt: status.state === 'pending' ? null : status.updated_at,
        url: status.target_url,
        isActions: false,
        isStatus: true
    };
}

/** Returns the newest check of each name, from the check runs and the commit statuses, sorted by name. */
export function mapChecks(runs: RestCheckRun[], statuses: RestStatus[]): CheckRun[] {
    const checks = [...runs.map(mapCheckRun), ...statuses.map(mapCommitStatus)];
    return latestChecks(checks).sort((a, b) => a.name.localeCompare(b.name));
}

/** Changes a job and its steps to the shared type. A job without steps gets an empty list. */
export function mapJobProgress(job: RestJob): JobProgress {
    return {
        status: job.status,
        conclusion: job.conclusion,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        steps: (job.steps ?? []).map(step => ({
            number: step.number,
            name: step.name,
            status: step.status,
            conclusion: step.conclusion,
            startedAt: step.started_at,
            completedAt: step.completed_at
        }))
    };
}

/** Changes a job of a workflow run to a check, so that the log view can show its log. */
export function mapRunJob(job: RestRunJob): CheckRun {
    return {
        id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        url: job.html_url,
        runId: job.run_id,
        isActions: true
    };
}

/** Changes a workflow run to the shared type. The actor that started the run again wins over the first actor. */
export function mapWorkflowRun(run: RestWorkflowRun): WorkflowRun {
    return {
        id: run.id,
        title: run.display_title ?? run.name ?? `Run ${run.run_number}`,
        workflowId: run.workflow_id,
        workflowName: run.name ?? '',
        runNumber: run.run_number,
        branch: run.head_branch,
        event: run.event,
        status: run.status ?? 'queued',
        conclusion: run.conclusion,
        actor: run.triggering_actor?.login ?? run.actor?.login ?? null,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
        startedAt: run.run_started_at ?? null,
        url: run.html_url,
        headSha: run.head_sha
    };
}
