import type { AgentState } from './agents';
import { newPlanId, type Plan, type PlanStep, type StepPullRequest } from './plans';
import type { TerminalSession } from './terminal';
import { branchFromName } from './worktrees';

/**
 * Coordinator runs: an agent (the coordinator) splits a large task and starts worker agents with the MCP tool
 * start_worker. Each worker gets its own worktree and task. A coordinator run is a plan with `coordinator` set, and
 * each worker is a step of the plan. The worker sends its result with report_result, and ShipWarden tells the
 * coordinator. A worker can start its own workers up to the depth limit of Settings › Agents.
 *
 * The functions of this module use no Electron API and no browser API. The main process and the page both use them.
 */

/** ShipWarden tells the coordinator when a worker waits or is idle for this time without a report. */
export const WORKER_WAIT_NOTICE_MS = 10 * 60_000;
/** A new agent session can take this time to show in the session list. Before it, a missing session is not an exit. */
export const WORKER_START_GRACE_MS = 60_000;
/** The longest task text of a worker. */
export const MAX_WORKER_TASK = 20_000;
/** The longest report of a worker. */
export const MAX_WORKER_REPORT = 20_000;

/** The agent states in which a worker does not work. After `WORKER_WAIT_NOTICE_MS` in one of them, the coordinator gets a notice. */
const PAUSED_STATES: ReadonlySet<AgentState> = new Set(['waiting', 'done', 'idle']);

/** True when the worker did not finish: its agent works, or it waits. */
export function isWorkerOpen(step: Pick<PlanStep, 'status'>): boolean {
    return step.status === 'running' || step.status === 'attention' || step.status === 'pending';
}

/** The plans of the coordinator runs. */
export function coordinatorPlans(plans: readonly Plan[]): Plan[] {
    return plans.filter(plan => !!plan.coordinator);
}

/** The coordinator run of the agent in a worktree, if it has one. */
export function coordinatorPlanOf(plans: readonly Plan[], worktree: string): Plan | undefined {
    return plans.find(plan => plan.coordinator?.worktree === worktree);
}

/** The worker step that runs in a worktree, and its coordinator run. */
export function workerOf(plans: readonly Plan[], worktree: string): { plan: Plan; step: PlanStep } | undefined {
    for (const plan of coordinatorPlans(plans)) {
        const step = plan.steps.find(item => item.worktreePath === worktree);
        if (step) return { plan, step };
    }
    return undefined;
}

/** The depth of the agent in a worktree: 0 for an agent that the user started, else the depth of its worker step. */
export function depthOf(plans: readonly Plan[], worktree: string): number {
    return workerOf(plans, worktree)?.step.depth ?? 0;
}

/** The number of workers of all coordinator runs that did not finish. They count against the queue limit. */
export function openWorkerCount(plans: readonly Plan[]): number {
    return coordinatorPlans(plans).reduce((count, plan) => count + plan.steps.filter(isWorkerOpen).length, 0);
}

/**
 * Returns the error text when a new worker of an agent at `callerDepth` is deeper than the limit. Undefined: the start
 * can continue.
 */
export function depthError(callerDepth: number, maxDepth: number): string | undefined {
    if (callerDepth + 1 <= maxDepth) return undefined;
    const levels = maxDepth === 1 ? 'Only the agent that the user started can start workers.' : `A worker at depth ${maxDepth} cannot start workers.`;
    return `This agent is a worker at depth ${callerDepth}, and the limit is ${maxDepth}. ${levels} Do the work in this worktree, or ask the user to change Settings › Agents › Worker depth.`;
}

/** Returns the branch of a new worker, for example "worker/add-the-login-page-k3x9". */
export function workerBranch(title: string, id: string): string {
    const name = branchFromName(title)
        .replace(/\//g, '-')
        .slice(0, 40)
        .replace(/[-.]+$/, '');
    const suffix = id
        .replace(/[^a-z0-9]/gi, '')
        .slice(-4)
        .toLowerCase();
    return `worker/${name || 'task'}-${suffix}`;
}

/** Returns the first line of a task, cut to a title. */
export function workerTitle(task: string): string {
    const line =
        task
            .split('\n')
            .find(item => item.trim())
            ?.trim() ?? 'Worker';
    const plain = line.replace(/^#+\s*/, '');
    return plain.length > 80 ? `${plain.slice(0, 79)}…` : plain;
}

/** A new coordinator run for the agent in a worktree. */
export function newCoordinatorPlan(input: { projectId: string; worktree: string; name: string; sessionId?: string; depth: number; now: number }): Plan {
    return {
        id: newPlanId(),
        projectId: input.projectId,
        title: `Workers of ${input.name}`.slice(0, 120),
        idea: '',
        steps: [],
        status: 'running',
        draftPullRequests: false,
        coordinator: { worktree: input.worktree, depth: input.depth, ...(input.sessionId ? { sessionId: input.sessionId } : {}) },
        createdAt: input.now,
        updatedAt: input.now,
        executedAt: input.now
    };
}

/** A new worker step. The step runs at once. */
export function newWorkerStep(input: {
    title: string;
    task: string;
    repo: string;
    branch: string;
    baseBranch?: string;
    worktreePath: string;
    sessionId: string;
    depth: number;
    now: number;
    id?: string;
}): PlanStep {
    return {
        id: input.id ?? newPlanId(),
        title: input.title,
        description: input.task,
        repo: input.repo,
        task: { kind: 'none' },
        pullRequest: true,
        skip: false,
        status: 'running',
        detail: 'The agent is working.',
        branch: input.branch,
        ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        worktreePath: input.worktreePath,
        sessionId: input.sessionId,
        depth: input.depth,
        startedAt: input.now
    };
}

/** Returns the prompt of a new worker. */
export function workerPrompt(input: { task: string; coordinator: string; depth: number; maxDepth: number }): string {
    const canStart = input.depth < input.maxDepth;
    return [
        `You are a worker agent. The coordinator agent in "${input.coordinator}" started you through ShipWarden. You work in your own git worktree and branch.`,
        `Your task:\n\n${input.task}`,
        'When you finish:',
        [
            '1. Commit your changes.',
            '2. Push the branch, and open a pull request with the ShipWarden tool create_pull_request, unless the task says something different.',
            '3. Call the ShipWarden tool report_result with a short summary of the result. Include what you did not do and any open questions.'
        ].join('\n'),
        'If you cannot finish the task, call report_result with "status" set to "failed" and the reason.',
        canStart ? 'You can split your task and start your own workers with start_worker.' : 'You cannot start workers. Do all the work in this worktree.'
    ].join('\n\n');
}

/** What ShipWarden sees of the agent of a worker. */
export type WorkerObservation =
    /** The agent tab exited, or it is not in the session list after the start time. */
    | { kind: 'stopped' }
    /** The agent waits or is idle for `WORKER_WAIT_NOTICE_MS`. */
    | { kind: 'waiting'; since: number; message?: string; state: AgentState }
    /** The agent works again after a wait. */
    | { kind: 'working' };

/** Returns what changed for an open worker, or undefined when nothing changed. */
export function observeWorker(step: PlanStep, session: TerminalSession | undefined, now: number): WorkerObservation | undefined {
    if (!isWorkerOpen(step)) return undefined;
    if (!session) return now - (step.startedAt ?? 0) >= WORKER_START_GRACE_MS ? { kind: 'stopped' } : undefined;
    if (session.exited || session.agentState === 'exited') return { kind: 'stopped' };
    const state = session.agentState;
    const since = session.agentStateAt;
    if (state && PAUSED_STATES.has(state) && since !== undefined) {
        if (now - since < WORKER_WAIT_NOTICE_MS || (step.status === 'attention' && step.waitAt === since)) return undefined;
        return { kind: 'waiting', since, state, ...(session.agentMessage ? { message: session.agentMessage } : {}) };
    }
    if (step.status === 'attention' && (state === 'working' || state === 'starting')) return { kind: 'working' };
    return undefined;
}

/** Returns the step after an observation. `pr` is the pull request of the branch, when ShipWarden found one. */
export function applyObservation(step: PlanStep, observation: WorkerObservation, now: number, pr?: StepPullRequest): PlanStep {
    switch (observation.kind) {
        case 'stopped':
            return {
                ...step,
                status: pr ? 'done' : 'failed',
                detail: pr
                    ? 'The agent stopped without a report. Its branch has a pull request.'
                    : 'The agent stopped without a report, and its branch has no pull request.',
                finishedAt: now,
                ...(pr ? { pr } : {})
            };
        case 'waiting': {
            const what = observation.state === 'waiting' ? 'is waiting for an answer' : 'is not working';
            const message = observation.message ? ` Its last message: ${clip(observation.message, 300)}` : '';
            return { ...step, status: 'attention', detail: `The agent ${what} for 10 minutes and sent no report.${message}`, waitAt: observation.since };
        }
        case 'working':
            return { ...step, status: 'running', detail: 'The agent is working.' };
    }
}

/** Returns the step after report_result. */
export function applyReport(step: PlanStep, report: { summary: string; failed: boolean }, now: number, pr?: StepPullRequest): PlanStep {
    return {
        ...step,
        status: report.failed ? 'failed' : 'done',
        report: report.summary.slice(0, MAX_WORKER_REPORT),
        detail: report.failed ? 'The worker reported that it could not finish the task.' : 'The worker sent its result.',
        finishedAt: now,
        ...(pr ? { pr } : {})
    };
}

/** A message for the coordinator about one worker. `key` is unique for each event, so each event goes out one time. */
export interface WorkerNotice {
    key: string;
    message: string;
}

/** Returns the notice that the coordinator did not get yet for a worker, or undefined. */
export function workerNotice(step: PlanStep): WorkerNotice | undefined {
    let key: string;
    if (step.status === 'done' || step.status === 'failed') key = `end:${step.finishedAt ?? 0}`;
    else if (step.status === 'attention') key = `wait:${step.waitAt ?? 0}`;
    else return undefined;
    if (step.noticeKey === key) return undefined;
    return { key, message: noticeMessage(step) };
}

function noticeMessage(step: PlanStep): string {
    const name = `The worker "${step.title}" (worker_id "${step.id}", branch ${step.branch ?? 'unknown'})`;
    const pr = step.pr ? `\n\nPull request: ${step.pr.url}` : '';
    const report = step.report ? `\n\nReport of the worker:\n\n${step.report}` : '';
    switch (step.status) {
        case 'done':
            return `ShipWarden: ${name} finished.${pr}${report}`;
        case 'failed':
            return `ShipWarden: ${name} did not finish. ${step.detail ?? ''}${pr}${report}`.trim();
        default:
            return `ShipWarden: ${name} needs attention. ${step.detail ?? ''} Its worktree is ${step.worktreePath ?? 'unknown'}. Tell the user, or wait for the worker with wait_for_worker.`;
    }
}

/** The words of a worker status for the agent. */
const WORKER_STATUS: Record<PlanStep['status'], string> = {
    pending: 'starting',
    running: 'working',
    attention: 'needs_attention',
    done: 'done',
    failed: 'failed',
    skipped: 'skipped'
};

/** Returns a worker for the result of list_workers and wait_for_worker. */
export function workerSummary(step: PlanStep, session?: Pick<TerminalSession, 'agentState' | 'agentMessage' | 'exited'>): Record<string, unknown> {
    return {
        worker_id: step.id,
        title: step.title,
        status: WORKER_STATUS[step.status],
        ...(step.detail ? { detail: step.detail } : {}),
        ...(step.branch ? { branch: step.branch } : {}),
        ...(step.worktreePath ? { worktree: step.worktreePath } : {}),
        ...(step.depth ? { depth: step.depth } : {}),
        ...(session && !session.exited && session.agentState ? { agentState: session.agentState } : {}),
        ...(step.pr ? { pullRequest: step.pr.url } : {}),
        ...(step.report ? { report: step.report } : {})
    };
}

/** Returns the number of a pull request address of GitHub, GitLab, Bitbucket, or Azure DevOps, or undefined. */
export function pullRequestNumberOf(url: string): number | undefined {
    const match = /\/(?:pull|pulls|merge_requests|pull-requests|pullrequest)\/(\d+)(?:[/?#]|$)/i.exec(url);
    const number = match ? Number(match[1]) : Number.NaN;
    return Number.isInteger(number) && number > 0 ? number : undefined;
}

function clip(text: string, max: number): string {
    const value = text.replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** The status labels of a worker in the Plans view. */
export const WORKER_STATUS_LABELS: Record<PlanStep['status'], string> = {
    pending: 'Starting',
    running: 'Agent is working',
    attention: 'Needs attention',
    done: 'Done',
    failed: 'Failed',
    skipped: 'Skipped'
};
