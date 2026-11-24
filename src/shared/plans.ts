import { isAgentMode, type AgentMode } from './agent-modes';
import type { AgentProgram } from './agent-programs';
import { shellQuote, type AgentState } from './agents';
import { fence } from './ask-agent';
import { MAX_GROUP_PULL_REQUESTS } from './pr-groups';
import type { TaskLink } from './tasks';

/**
 * Plans: an idea for a project, broken into steps. An agent reads all repositories of the project and proposes the
 * steps. The user edits the steps, and then executes the plan. Each step runs in its own worktree, one step after the
 * other. With "Stack the steps" (the default), steps in the same repository stack: each branch starts from the branch
 * of the step before it, and its pull request targets that branch. When a lower pull request merges, ShipWarden rebases
 * the next branch onto the new base and changes the base of its pull request.
 *
 * The functions of this module use no Electron API and no browser API. The main process and the page both use them.
 */

/**
 * "draft": the user edits the plan. "running": the plan executes its steps. "paused": a step needs the user, or the
 * user stopped the plan. "done": all steps are done or skipped.
 */
export type PlanStatus = 'draft' | 'running' | 'paused' | 'done';

/**
 * "pending": the step did not start. "running": an agent works on the step. "attention": the agent finished its turn,
 * and the step needs the user. "done": the step is complete. "skipped": the plan does not run the step.
 * "failed": ShipWarden could not do a part of the step, for example the push.
 */
export type StepStatus = 'pending' | 'running' | 'attention' | 'done' | 'skipped' | 'failed';

/** The task of a step. "new" makes a task when the plan starts. Then the step has an "existing" task. */
export type StepTask = { kind: 'none' } | { kind: 'new' } | { kind: 'existing'; link: TaskLink; created?: boolean };

/** The pull request of a step. */
export interface StepPullRequest {
    number: number;
    url: string;
    /** The target branch of the pull request. */
    base: string;
}

export interface PlanStep {
    id: string;
    title: string;
    /** The work of the step, in Markdown. The agent gets it in its prompt. */
    description: string;
    /** The root folder of the main worktree of the repository. */
    repo?: string;
    task: StepTask;
    /** True: ShipWarden pushes the branch and opens a pull request when the agent finishes. */
    pullRequest: boolean;
    /** True: the plan does not run the step. */
    skip: boolean;
    status: StepStatus;
    /** The last message of the run of the step, for example why it needs the user. */
    detail?: string;
    branch?: string;
    /** The branch that the worktree started from. Undefined: the default branch. */
    baseBranch?: string;
    worktreePath?: string;
    sessionId?: string;
    /** The commit of the worktree at the start. A different commit at the end shows that the agent committed. */
    startHead?: string;
    /** The start of the agent turn of the step, in milliseconds. An earlier "done" state is not for this step. */
    turnFrom?: number;
    pr?: StepPullRequest;
    startedAt?: number;
    finishedAt?: number;
    /** A short text about the step for the user. The agent of the step gets `description`, not this text. */
    summary?: string;
    /** The files, folders and modules that the step changes, for example "src/utils" or "OrganizationService". */
    touches?: string[];
    /** True: the user read the step and said that it is correct. A draft runs only when all its steps are reviewed. */
    reviewed?: boolean;
    /** The last work that the user gave to the agent of a done step, for example "Fixing the review comments". */
    followUp?: { label: string; at: number };
    /**
     * The commit of the parent branch when this branch started from it: the old base for "git rebase --onto" after
     * the parent merges. A squash merge needs it, because the new base does not contain the commits of the parent.
     */
    stackBase?: string;
    /** When ShipWarden saw that the pull request of the step merged and restacked the next steps. */
    mergedAt?: number;
    /** The rebase of the branch after the pull request below it merged. Undefined: no rebase waits for an action. */
    restack?: StepRestack;
    /** A worker of a coordinator run: its depth. The workers of a coordinator have depth 1, and their workers have depth 2. */
    depth?: number;
    /** A worker of a coordinator run: the result that the worker sent with report_result, in Markdown. */
    report?: string;
    /** A worker of a coordinator run: the key of the last notice that the coordinator got (see `workerNotice`). */
    noticeKey?: string;
    /** A worker of a coordinator run: the time of the agent state that waits for 10 minutes. */
    waitAt?: number;
}

/**
 * The rebase of a stacked branch onto a new base:
 * - "push": the rebase is complete, and the branch waits for a push with "--force-with-lease".
 * - "conflict": the rebase stopped on a conflict. The agent of the worktree or the user resolves it.
 * - "failed": the rebase did not start, for example because the worktree has uncommitted changes.
 */
export interface StepRestack {
    /** The new base branch, for example "main". */
    onto: string;
    state: RestackState;
    /** The merged pull request below the step. */
    merged: number;
    /** The commits of the old base, for "git rebase --onto". A second try uses them again. */
    oldBases?: string[];
}

export type RestackState = 'push' | 'conflict' | 'failed';
const RESTACK_STATES: readonly RestackState[] = ['push', 'conflict', 'failed'];
const COMMIT_HASH = /^[0-9a-f]{7,64}$/i;

/**
 * A decision that the agent made for the plan, for example "One demo organization per director". The user must
 * confirm each decision before the plan runs. To change a decision, the agent revises the plan.
 */
export interface PlanDecision {
    id: string;
    /** One short sentence. */
    text: string;
    /** Why the agent made the decision, or what the other choices are. */
    detail?: string;
    confirmed: boolean;
}

/** A key fact of the approach, for example the label "Data model" and the text "is_demo + a database trigger". */
export interface PlanHighlight {
    label: string;
    text: string;
}

/** The task manager and the collection where "new" tasks go. */
export interface PlanTaskTarget {
    connectionId: string;
    collectionId: string;
    collectionName?: string;
}

export interface Plan {
    id: string;
    projectId: string;
    title: string;
    /** The idea of the user, as the user typed it. */
    idea: string;
    /** The full write-up of the agent, in Markdown. */
    summary?: string;
    /** Two or three sentences about the approach, from the agent. */
    approach?: string;
    /** The key facts of the approach. */
    highlights?: PlanHighlight[];
    /** The decisions that the user must confirm before the plan runs. */
    decisions?: PlanDecision[];
    steps: PlanStep[];
    status: PlanStatus;
    taskTarget?: PlanTaskTarget;
    /** The permission mode of the agents of the steps. Undefined: the mode of the agent in Settings › Agents. */
    agentMode?: AgentMode;
    /** True: the pull requests are drafts. */
    draftPullRequests: boolean;
    /** True: the pull requests of the plan do not go into a PR group. Undefined: they go into the group of the plan. */
    noPrGroup?: boolean;
    /**
     * True: each step starts from the default branch, and its pull request targets the default branch. Undefined
     * ("Stack the steps"): each step starts from the branch of the step before it in the same repository.
     */
    noStack?: boolean;
    /** True: the agent of a step continues to run after the step is done. Undefined: ShipWarden stops the agent. */
    keepAgents?: boolean;
    /**
     * True: when ShipWarden opens the pull request of a step, the agent of the step watches the CI checks and fixes the
     * failures. This applies only with `keepAgents`.
     */
    watchCi?: boolean;
    /** The name of the agent that wrote the last proposal. */
    agent?: string;
    /**
     * A coordinator run: an agent starts workers with the MCP tool start_worker, and each worker is a step. The main
     * process changes the plan. The plan runner of the page does not run it.
     */
    coordinator?: PlanCoordinator;
    createdAt: number;
    updatedAt: number;
    executedAt?: number;
    finishedAt?: number;
}

/** The agent of a coordinator run. */
export interface PlanCoordinator {
    /** The worktree of the coordinator agent. */
    worktree: string;
    /** The terminal session of the coordinator agent. The notices about the workers go to this session. */
    sessionId?: string;
    /** 0 for an agent that the user started. A worker that starts workers has its own depth. */
    depth: number;
}

/** A request to the main process to explore an idea. The agent reads the repositories and does not change files. */
export interface PlanExploreRequest {
    /** An ID for `cancelExplore`. The plan ID is sufficient. */
    id: string;
    /** The repository folders of the project. The agent runs in the first one and can read all of them. */
    repos: string[];
    /** The full prompt, from `explorePrompt`. */
    prompt: string;
}

export interface PlanExploreResult {
    agent: string;
    answer: string;
}

/** A proposal of the agent, from `parseProposal`. */
export interface PlanProposal {
    title?: string;
    summary?: string;
    highlights?: PlanHighlight[];
    decisions?: Pick<PlanDecision, 'text' | 'detail'>[];
    steps: Pick<PlanStep, 'title' | 'description' | 'repo' | 'pullRequest' | 'summary' | 'touches'>[];
}

export const MAX_TITLE_LENGTH = 120;

/** The title of a new plan. The plan gets the title of its first step, or the title of the proposal of an agent. */
export const NEW_PLAN_TITLE = 'New plan';
const MAX_TEXT_LENGTH = 50_000;
/** Each step can open a pull request, and all pull requests of the plan go into one PR group. */
export const MAX_PLAN_STEPS = MAX_GROUP_PULL_REQUESTS;
const MAX_DECISIONS = 20;
const MAX_HIGHLIGHTS = 8;
const MAX_TOUCHES = 20;

export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
    pending: 'Not started',
    running: 'Agent is working',
    attention: 'Stopped',
    done: 'Done',
    skipped: 'Skipped',
    failed: 'Failed'
};

/**
 * Returns the status label of a step. The label is "Needs you" only when the agent of the step waits for an answer or
 * a permission. A step that stopped for another reason shows its usual label.
 */
export function stepStatusLabel(status: StepStatus, agentState?: AgentState): string {
    if (agentState === 'waiting' && (status === 'running' || status === 'attention')) return 'Needs you';
    return STEP_STATUS_LABELS[status];
}

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
    draft: 'Draft',
    running: 'Running',
    paused: 'Paused',
    done: 'Done'
};

/** Makes a short random ID. */
export function newPlanId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Returns a new empty step. */
export function newStep(repo?: string): PlanStep {
    return {
        id: newPlanId(),
        title: '',
        description: '',
        ...(repo ? { repo } : {}),
        task: { kind: 'none' },
        pullRequest: true,
        skip: false,
        status: 'pending'
    };
}

/** Returns a new draft plan for a project. */
export function newPlan(projectId: string, now: number): Plan {
    return {
        id: newPlanId(),
        projectId,
        title: NEW_PLAN_TITLE,
        idea: '',
        steps: [],
        status: 'draft',
        draftPullRequests: false,
        createdAt: now,
        updatedAt: now
    };
}

/** Returns a draft copy of the plan, with new IDs and no results of a run. New tasks that the run made stay linked. */
export function duplicatePlan(plan: Plan, now: number): Plan {
    return {
        ...newPlan(plan.projectId, now),
        title: `${plan.title} (copy)`.slice(0, MAX_TITLE_LENGTH),
        idea: plan.idea,
        ...(plan.summary ? { summary: plan.summary } : {}),
        ...(plan.approach ? { approach: plan.approach } : {}),
        ...(plan.highlights ? { highlights: plan.highlights } : {}),
        ...(plan.decisions ? { decisions: plan.decisions.map(decision => ({ ...decision, id: newPlanId() })) } : {}),
        ...(plan.taskTarget ? { taskTarget: plan.taskTarget } : {}),
        ...(plan.agentMode ? { agentMode: plan.agentMode } : {}),
        draftPullRequests: plan.draftPullRequests,
        ...(plan.noPrGroup ? { noPrGroup: true } : {}),
        ...(plan.noStack ? { noStack: true } : {}),
        ...(plan.keepAgents ? { keepAgents: true } : {}),
        ...(plan.watchCi ? { watchCi: true } : {}),
        steps: plan.steps.map(step => ({
            id: newPlanId(),
            title: step.title,
            description: step.description,
            ...(step.repo ? { repo: step.repo } : {}),
            task: step.task.kind === 'existing' ? { kind: 'existing', link: step.task.link } : step.task,
            pullRequest: step.pullRequest,
            skip: step.skip || step.status === 'skipped',
            status: 'pending',
            ...(step.summary ? { summary: step.summary } : {}),
            ...(step.touches ? { touches: step.touches } : {}),
            ...(step.reviewed ? { reviewed: true } : {})
        }))
    };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Validation                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, max = MAX_TEXT_LENGTH): string | undefined {
    return typeof value === 'string' && value.length <= max ? value : undefined;
}

function nonEmpty(value: unknown, max = MAX_TEXT_LENGTH): string | undefined {
    const result = text(value, max);
    return result?.trim() ? result : undefined;
}

function time(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const STEP_STATUSES: readonly StepStatus[] = ['pending', 'running', 'attention', 'done', 'skipped', 'failed'];
const PLAN_STATUSES: readonly PlanStatus[] = ['draft', 'running', 'paused', 'done'];

function taskLinkOf(value: unknown): TaskLink | undefined {
    const raw = record(value);
    const pluginId = nonEmpty(raw.pluginId, 200);
    const taskId = nonEmpty(raw.taskId, 500);
    if (!pluginId || !taskId) return undefined;
    return {
        pluginId,
        taskId,
        title: text(raw.title, 1000) ?? '',
        ...(nonEmpty(raw.connectionId, 200) ? { connectionId: raw.connectionId as string } : {}),
        ...(nonEmpty(raw.key, 200) ? { key: raw.key as string } : {}),
        ...(nonEmpty(raw.url, 2000) ? { url: raw.url as string } : {})
    };
}

function stepTaskOf(value: unknown): StepTask {
    const raw = record(value);
    if (raw.kind === 'new') return { kind: 'new' };
    if (raw.kind === 'existing') {
        const link = taskLinkOf(raw.link);
        if (link) return { kind: 'existing', link, ...(raw.created === true ? { created: true } : {}) };
    }
    return { kind: 'none' };
}

function pullRequestOf(value: unknown): StepPullRequest | undefined {
    const raw = record(value);
    const number = raw.number;
    const url = nonEmpty(raw.url, 2000);
    const base = nonEmpty(raw.base, 300);
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || !url || !base) return undefined;
    return { number, url, base };
}

function restackOf(value: unknown): StepRestack | undefined {
    const raw = record(value);
    const onto = nonEmpty(raw.onto, 300);
    const merged = raw.merged;
    if (!onto || !RESTACK_STATES.includes(raw.state as RestackState) || typeof merged !== 'number' || !Number.isInteger(merged) || merged < 1) return undefined;
    const oldBases = textList(raw.oldBases, 4, 64).filter(commit => COMMIT_HASH.test(commit));
    return { onto, state: raw.state as RestackState, merged, ...(oldBases.length > 0 ? { oldBases } : {}) };
}

/** Returns a valid step, or undefined when the value has no ID. */
export function normalizeStep(value: unknown): PlanStep | undefined {
    const raw = record(value);
    const id = nonEmpty(raw.id, 100);
    if (!id) return undefined;
    const status = STEP_STATUSES.includes(raw.status as StepStatus) ? (raw.status as StepStatus) : 'pending';
    const step: PlanStep = {
        id,
        title: text(raw.title, MAX_TITLE_LENGTH) ?? '',
        description: text(raw.description) ?? '',
        task: stepTaskOf(raw.task),
        pullRequest: raw.pullRequest !== false,
        skip: raw.skip === true,
        status
    };
    const repo = nonEmpty(raw.repo, 4000);
    if (repo?.startsWith('/')) step.repo = repo;
    for (const key of ['detail', 'branch', 'baseBranch', 'worktreePath', 'sessionId', 'startHead'] as const) {
        const value = nonEmpty(raw[key], 8000);
        if (value) step[key] = value;
    }
    const stackBase = nonEmpty(raw.stackBase, 64);
    if (stackBase && COMMIT_HASH.test(stackBase)) step.stackBase = stackBase;
    const restack = restackOf(raw.restack);
    if (restack) step.restack = restack;
    for (const key of ['turnFrom', 'startedAt', 'finishedAt', 'mergedAt', 'waitAt'] as const) {
        const value = time(raw[key]);
        if (value !== undefined) step[key] = value;
    }
    const pr = pullRequestOf(raw.pr);
    if (pr) step.pr = pr;
    const summary = nonEmpty(raw.summary, 4000);
    if (summary) step.summary = summary;
    const touches = textList(raw.touches, MAX_TOUCHES, 300);
    if (touches.length > 0) step.touches = touches;
    if (raw.reviewed === true) step.reviewed = true;
    if (typeof raw.depth === 'number' && Number.isInteger(raw.depth) && raw.depth > 0 && raw.depth <= 10) step.depth = raw.depth;
    const report = nonEmpty(raw.report, 20_000);
    if (report) step.report = report;
    const noticeKey = nonEmpty(raw.noticeKey, 200);
    if (noticeKey) step.noticeKey = noticeKey;
    const followUp = record(raw.followUp);
    const label = nonEmpty(followUp.label, 200);
    const at = time(followUp.at);
    if (label && at !== undefined) step.followUp = { label, at };
    return step;
}

/** Returns the non-empty strings of a list, trimmed. */
function textList(value: unknown, maxItems: number, maxLength: number): string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => (nonEmpty(item, maxLength) ? [(item as string).trim()] : [])).slice(0, maxItems);
}

function highlightsOf(value: unknown): PlanHighlight[] {
    if (!Array.isArray(value)) return [];
    return value
        .flatMap(item => {
            const raw = record(item);
            const label = nonEmpty(raw.label, 100)?.trim();
            const content = nonEmpty(raw.text, 1000)?.trim();
            return label && content ? [{ label, text: content }] : [];
        })
        .slice(0, MAX_HIGHLIGHTS);
}

function decisionsOf(value: unknown): PlanDecision[] {
    if (!Array.isArray(value)) return [];
    const decisions: PlanDecision[] = [];
    for (const item of value) {
        const raw = record(item);
        const id = nonEmpty(raw.id, 100);
        const content = nonEmpty(raw.text, 1000)?.trim();
        if (!id || !content || decisions.some(decision => decision.id === id)) continue;
        const detail = nonEmpty(raw.detail, 4000)?.trim();
        decisions.push({ id, text: content, ...(detail ? { detail } : {}), confirmed: raw.confirmed === true });
        if (decisions.length >= MAX_DECISIONS) break;
    }
    return decisions;
}

/** Returns a valid plan, or undefined when the value has no ID or no project. */
export function normalizePlan(value: unknown): Plan | undefined {
    const raw = record(value);
    const id = nonEmpty(raw.id, 100);
    const projectId = nonEmpty(raw.projectId, 200);
    if (!id || !projectId) return undefined;
    const steps: PlanStep[] = [];
    for (const item of Array.isArray(raw.steps) ? raw.steps : []) {
        const step = normalizeStep(item);
        if (step && !steps.some(existing => existing.id === step.id) && steps.length < MAX_PLAN_STEPS) steps.push(step);
    }
    const target = record(raw.taskTarget);
    const now = Date.now();
    const plan: Plan = {
        id,
        projectId,
        title: nonEmpty(raw.title, MAX_TITLE_LENGTH)?.trim() ?? 'Untitled plan',
        idea: text(raw.idea) ?? '',
        steps,
        status: PLAN_STATUSES.includes(raw.status as PlanStatus) ? (raw.status as PlanStatus) : 'draft',
        draftPullRequests: raw.draftPullRequests === true,
        createdAt: time(raw.createdAt) ?? now,
        updatedAt: time(raw.updatedAt) ?? now
    };
    const summary = nonEmpty(raw.summary);
    if (summary) plan.summary = summary;
    const approach = nonEmpty(raw.approach, 4000);
    if (approach) plan.approach = approach;
    const highlights = highlightsOf(raw.highlights);
    if (highlights.length > 0) plan.highlights = highlights;
    const decisions = decisionsOf(raw.decisions);
    if (decisions.length > 0) plan.decisions = decisions;
    const connectionId = nonEmpty(target.connectionId, 200);
    const collectionId = nonEmpty(target.collectionId, 500);
    if (connectionId && collectionId) {
        plan.taskTarget = { connectionId, collectionId, ...(nonEmpty(target.collectionName, 500) ? { collectionName: target.collectionName as string } : {}) };
    }
    if (isAgentMode(raw.agentMode)) plan.agentMode = raw.agentMode;
    if (raw.noPrGroup === true) plan.noPrGroup = true;
    if (raw.noStack === true) plan.noStack = true;
    if (raw.keepAgents === true) plan.keepAgents = true;
    if (raw.watchCi === true) plan.watchCi = true;
    const agent = nonEmpty(raw.agent, 200);
    if (agent) plan.agent = agent;
    const coordinator = record(raw.coordinator);
    const coordinatorWorktree = nonEmpty(coordinator.worktree, 4000);
    if (coordinatorWorktree?.startsWith('/')) {
        const depth = typeof coordinator.depth === 'number' && Number.isInteger(coordinator.depth) && coordinator.depth >= 0 ? coordinator.depth : 0;
        const sessionId = nonEmpty(coordinator.sessionId, 200);
        plan.coordinator = { worktree: coordinatorWorktree, depth, ...(sessionId ? { sessionId } : {}) };
    }
    for (const key of ['executedAt', 'finishedAt'] as const) {
        const value = time(raw[key]);
        if (value !== undefined) plan[key] = value;
    }
    return plan;
}

/** A problem that stops the execution of a plan. */
export interface PlanProblem {
    /** One sentence for the list of problems, for example "Step 3 has no repository." */
    message: string;
    /** The step with the problem. Undefined: a problem of the plan. */
    stepId?: string;
    /** The field of the step with the problem. */
    field?: 'title' | 'repo' | 'task';
    /** One sentence for the step itself, without the step number. */
    hint?: string;
}

/**
 * Returns the problems that stop the execution of the plan. Empty: the plan can run.
 * `repos` are the repositories of the project now.
 */
export function planProblems(plan: Plan, repos: readonly string[], canCreateTasks: boolean): PlanProblem[] {
    const problems: PlanProblem[] = [];
    const active = plan.steps.filter(step => !step.skip);
    if (active.length === 0) problems.push({ message: 'The plan has no steps to run. Add a step, or include a skipped step.' });
    active.forEach(step => {
        const name = `Step ${plan.steps.indexOf(step) + 1}`;
        const add = (field: PlanProblem['field'], message: string, hint: string) => problems.push({ message, stepId: step.id, field, hint });
        if (!step.title.trim()) add('title', `${name} has no title.`, 'Write a title for this step.');
        if (!step.repo) add('repo', `${name} has no repository.`, 'Choose the repository this step runs in.');
        else if (!repos.includes(step.repo)) {
            add(
                'repo',
                `${name}: the repository is not in the project anymore.`,
                'The repository is not in the project anymore. Choose a different repository.'
            );
        }
    });
    // One problem for all steps with a new task. The fix is in the settings of the plan, not in the steps.
    const newTaskSteps = active.filter(step => step.task.kind === 'new').map(step => plan.steps.indexOf(step) + 1);
    if (newTaskSteps.length > 0 && (!plan.taskTarget || !canCreateTasks)) {
        const steps = newTaskSteps.length === 1 ? `Step ${newTaskSteps[0]} makes a new task` : `${newTaskSteps.length} steps make new tasks`;
        problems.push({
            message: plan.taskTarget ? `${steps}, but the task manager cannot make tasks.` : `${steps}. Select a task manager and a collection.`,
            field: 'task'
        });
    }
    return problems;
}

/**
 * Returns the index of the step that the step at `index` stacks on: the nearest earlier step in the same repository
 * that runs. Returns -1 when the step starts from the default branch. `stack` is false when the plan does not stack.
 */
export function stackedOnIndex(steps: readonly PlanStep[], index: number, stack = true): number {
    const step = steps[index];
    if (!stack || !step?.repo || step.skip) return -1;
    for (let at = index - 1; at >= 0; at--) {
        if (steps[at].repo === step.repo && !steps[at].skip) return at;
    }
    return -1;
}

/** What the user must still review before the plan can run. Skipped steps need no review. */
export interface PlanReview {
    /** The steps that will run. */
    steps: number;
    reviewedSteps: number;
    decisions: number;
    openDecisions: number;
    /** True: all steps that will run are reviewed, and all decisions are confirmed. */
    complete: boolean;
}

export function planReview(plan: Pick<Plan, 'steps' | 'decisions'>): PlanReview {
    const active = plan.steps.filter(step => !step.skip);
    const reviewedSteps = active.filter(step => step.reviewed).length;
    const decisions = plan.decisions ?? [];
    const openDecisions = decisions.filter(decision => !decision.confirmed).length;
    return {
        steps: active.length,
        reviewedSteps,
        decisions: decisions.length,
        openDecisions,
        complete: reviewedSteps === active.length && openDecisions === 0
    };
}

/** One sentence about what the user must still review, for example "Review 2 steps and confirm 1 decision." */
export function reviewText(review: PlanReview): string {
    const steps = review.steps - review.reviewedSteps;
    const parts = [
        steps > 0 ? `review ${steps === 1 ? '1 step' : `${steps} steps`}` : '',
        review.openDecisions > 0 ? `confirm ${review.openDecisions === 1 ? '1 decision' : `${review.openDecisions} decisions`}` : ''
    ].filter(Boolean);
    if (parts.length === 0) return 'All steps are reviewed and all decisions are confirmed.';
    const sentence = parts.join(' and ');
    return `${sentence[0].toUpperCase()}${sentence.slice(1)} to run the plan.`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Exploration                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The repository of a prompt: its name and its folder. */
export interface PromptRepo {
    name: string;
    path: string;
}

/** Returns the prompt that asks the agent for a plan. With `current` and `feedback`, the agent revises the current plan. */
export function explorePrompt(input: { idea: string; repos: readonly PromptRepo[]; current?: Plan; feedback?: string }): string {
    const repoLines = input.repos.map(repo => `- ${repo.name}: ${repo.path}`).join('\n');
    const parts = [
        'I want to explore an idea for a project with these git repositories. Each line has the name and the folder of a repository:',
        repoLines,
        `The idea:\n\n${quoted(input.idea.trim() || '(No text. Look at the current plan below.)')}`
    ];
    if (input.current && input.current.steps.length > 0) {
        const steps = input.current.steps
            .map((step, index) => {
                const repo = input.repos.find(item => item.path === step.repo)?.name ?? 'no repository';
                const flags = [step.skip ? 'skipped' : '', step.pullRequest ? 'pull request' : 'no pull request'].filter(Boolean).join(', ');
                return `${index + 1}. ${step.title} [${repo}; ${flags}]\n${indent(step.description.trim())}`;
            })
            .join('\n');
        parts.push(`The current plan:\n\n${quoted(steps)}`);
    }
    const decisions = input.current?.decisions ?? [];
    if (decisions.length > 0) {
        const lines = decisions.map(decision => `- ${decision.text}${decision.confirmed ? ' (confirmed by the user)' : ''}`).join('\n');
        parts.push(
            `The decisions of the current plan:\n\n${quoted(lines)}\n\nKeep the exact text of each decision that you do not change. The user confirmed some of them.`
        );
    }
    if (input.feedback?.trim()) {
        parts.push(`Change the plan with this feedback:\n\n${quoted(input.feedback.trim())}`);
    }
    parts.push(
        [
            'Read the code of the repositories that are related to the idea. Do not change files.',
            'Then propose a plan: a list of steps in the order to do them. Each step is one pull request in one repository.',
            'A step must be small enough for one agent session. A step in one repository can depend on an earlier step in the same repository or in a different repository.',
            'Write the description of each step as instructions for a coding agent: what to change, which files, and how to test it.',
            'Also write a "summary" of each step for the user: one or two sentences. In "touches", list the files, folders, classes or modules that the step changes.',
            'In "decisions", list each choice that you made and that the user must agree with, for example a product rule, a limit or a default. Write each decision as one short sentence. In "detail", write why, or the other choices. Do not list choices that only one answer can satisfy.',
            'In "highlights", give two to six key facts of the approach, each with a short label, for example { "label": "Data model", "text": "is_demo flag + a database trigger" }.',
            'Use the exact repository names from the list.',
            'Answer with a short summary in Markdown, and then one JSON code block with this form:',
            '```json\n{\n  "title": "A short title for the plan",\n  "summary": "Two or three sentences about the approach",\n  "highlights": [{ "label": "A short label", "text": "A short fact" }],\n  "decisions": [{ "text": "One short sentence", "detail": "Why, or the other choices" }],\n  "steps": [\n    { "title": "A short title", "repo": "repository name", "summary": "One or two sentences for the user", "touches": ["src/file.ts"], "description": "Markdown instructions", "pullRequest": true }\n  ]\n}\n```',
            'Set "pullRequest" to false for a step that is only an experiment, for example a proof of concept.'
        ].join('\n')
    );
    return parts.join('\n\n');
}

function quoted(value: string): string {
    const marker = fence(value);
    return `${marker}\n${value}\n${marker}`;
}

function indent(value: string): string {
    return value
        .split('\n')
        .map(line => `   ${line}`)
        .join('\n');
}

/**
 * Reads the plan from the answer of the agent: the last JSON code block, or else the last JSON object in the text.
 * The repository names become folders. A step with an unknown repository gets no repository.
 * Throws an error with a message when the answer has no plan.
 */
export function parseProposal(answer: string, repos: readonly PromptRepo[]): PlanProposal {
    const value = lastJson(answer);
    if (!value) throw new Error('The answer of the agent has no plan in JSON. Explore again, or add the steps yourself.');
    const raw = record(value);
    const list = Array.isArray(raw.steps) ? raw.steps : [];
    const steps = list.slice(0, MAX_PLAN_STEPS).flatMap(item => {
        const step = record(item);
        const title = nonEmpty(step.title, 1000)?.trim();
        if (!title) return [];
        const repo = matchRepo(typeof step.repo === 'string' ? step.repo : '', repos);
        const summary = nonEmpty(step.summary, 4000)?.trim();
        const touches = textList(step.touches, MAX_TOUCHES, 300);
        return [
            {
                title: title.slice(0, MAX_TITLE_LENGTH),
                description: text(step.description) ?? '',
                ...(repo ? { repo } : {}),
                pullRequest: step.pullRequest !== false,
                ...(summary ? { summary } : {}),
                ...(touches.length > 0 ? { touches } : {})
            }
        ];
    });
    if (steps.length === 0) throw new Error('The plan of the agent has no steps. Explore again, or add the steps yourself.');
    const title = nonEmpty(raw.title, 1000)?.trim().slice(0, MAX_TITLE_LENGTH);
    const summary = nonEmpty(raw.summary);
    const highlights = highlightsOf(raw.highlights);
    const decisions = (Array.isArray(raw.decisions) ? raw.decisions : []).flatMap(item => {
        // An agent can write a decision as a plain string.
        const decision = typeof item === 'string' ? { text: item } : record(item);
        const content = nonEmpty(decision.text, 1000)?.trim();
        const detail = nonEmpty(decision.detail, 4000)?.trim();
        return content ? [{ text: content, ...(detail ? { detail } : {}) }] : [];
    });
    return {
        steps,
        ...(title ? { title } : {}),
        ...(summary ? { summary: summary.trim() } : {}),
        ...(highlights.length > 0 ? { highlights } : {}),
        ...(decisions.length > 0 ? { decisions: decisions.slice(0, MAX_DECISIONS) } : {})
    };
}

/** The Markdown of the answer before its JSON block: the summary for the user. */
export function answerProse(answer: string): string {
    const index = answer.lastIndexOf('```json');
    return (index >= 0 ? answer.slice(0, index) : answer).trim();
}

function lastJson(answer: string): unknown {
    const blocks = [...answer.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)].map(match => match[1]);
    for (const block of blocks.reverse()) {
        const value = tryJson(block);
        if (value !== undefined) return value;
    }
    const start = answer.indexOf('{');
    const end = answer.lastIndexOf('}');
    return start >= 0 && end > start ? tryJson(answer.slice(start, end + 1)) : undefined;
}

function tryJson(source: string): unknown {
    try {
        const value = JSON.parse(source) as unknown;
        return value && typeof value === 'object' ? value : undefined;
    } catch {
        return undefined;
    }
}

function matchRepo(name: string, repos: readonly PromptRepo[]): string | undefined {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return undefined;
    return (
        repos.find(repo => repo.name.toLowerCase() === wanted || repo.path === name.trim())?.path ??
        repos.find(repo => wanted.endsWith(`/${repo.name.toLowerCase()}`))?.path
    );
}

function sameText(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Replaces the steps and the decisions of a draft with a proposal. The task choices of steps with the same title stay.
 * A step stays reviewed only when its repository and its instructions did not change. A decision stays confirmed only
 * when its text did not change.
 */
export function applyProposal(plan: Plan, proposal: PlanProposal, agent: string, now: number): Plan {
    const steps = proposal.steps.map(item => {
        const before = plan.steps.find(step => sameText(step.title, item.title));
        const unchanged = before?.reviewed && before.repo === item.repo && before.description.trim() === item.description.trim();
        return {
            ...newStep(item.repo),
            ...item,
            ...(before ? { task: before.task, skip: before.skip } : {}),
            ...(unchanged ? { reviewed: true } : {})
        };
    });
    const decisions = (proposal.decisions ?? []).map(item => {
        const before = plan.decisions?.find(decision => sameText(decision.text, item.text));
        return { id: before?.id ?? newPlanId(), ...item, confirmed: before?.confirmed === true };
    });
    const keepTitle = plan.title !== NEW_PLAN_TITLE && plan.title.trim();
    return {
        ...plan,
        title: keepTitle ? plan.title : (proposal.title ?? plan.title),
        ...(proposal.summary ? { summary: proposal.summary } : {}),
        // A new proposal replaces the approach, the highlights and the decisions of the old proposal.
        approach: proposal.summary,
        highlights: proposal.highlights,
        decisions: decisions.length > 0 ? decisions : undefined,
        steps,
        agent,
        updatedAt: now
    };
}

/**
 * Returns the print-mode command with options that let the agent read the other repositories.
 * The agent runs in the first repository. Claude Code gets "--add-dir" and Gemini CLI gets "--include-directories".
 * The read-only sandbox of Codex can read all folders. opencode gets no option.
 */
export function exploreCommand(print: string, program: AgentProgram | undefined, otherRepos: readonly string[]): string {
    if (otherRepos.length === 0) return print;
    switch (program) {
        case 'claude':
            return `${print} --add-dir ${otherRepos.map(shellQuote).join(' ')}`;
        case 'gemini':
            return `${print} --include-directories ${shellQuote(otherRepos.join(','))}`;
        default:
            return print;
    }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Execution                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

function slug(value: string, max: number): string {
    return (
        value
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, max)
            .replace(/-+$/, '') || 'step'
    );
}

/**
 * Returns the branch of a step: "plan/<plan>-<id>/<number>-<step>". All branches of a plan are in one folder, and
 * no branch has the name of that folder, so git can make all of them.
 */
export function stepBranch(plan: Pick<Plan, 'id' | 'title'>, step: Pick<PlanStep, 'title'>, index: number): string {
    return `plan/${slug(plan.title, 32)}-${planShortId(plan)}/${index + 1}-${slug(step.title, 40)}`;
}

/** The last 4 letters and digits of the plan ID, in lowercase. */
function planShortId(plan: Pick<Plan, 'id'>): string {
    return (
        plan.id
            .replace(/[^a-z0-9]/gi, '')
            .slice(-4)
            .toLowerCase() || 'plan'
    );
}

/**
 * The task of a step for the branch template in Settings › Worktrees. A step with a task uses that task. A step
 * without a task uses the title of the step, and the ID "<plan>-<number>", for example "ab12-3".
 */
export function stepBranchTask(
    plan: Pick<Plan, 'id'>,
    step: Pick<PlanStep, 'title' | 'description' | 'task'>,
    index: number
): { id: string; key?: string; title: string; description: string } {
    if (step.task.kind === 'existing') {
        const { link } = step.task;
        return { id: link.taskId, ...(link.key ? { key: link.key } : {}), title: link.title, description: step.description };
    }
    return { id: `${planShortId(plan)}-${index + 1}`, title: step.title, description: step.description };
}

/**
 * Returns the branch, or the branch with "-2", "-3", and so on, when `taken` has the branch already. Two steps of
 * the same task get two branches, and a step does not use a branch that exists in the repository.
 */
export function freeBranchName(branch: string, taken: Iterable<string>): string {
    const used = new Set(taken);
    if (!used.has(branch)) return branch;
    let number = 2;
    while (used.has(`${branch}-${number}`)) number++;
    return `${branch}-${number}`;
}

/** The index of the next step to run: the first step that is not skipped and did not start. -1 when there is none. */
export function nextStepIndex(plan: Pick<Plan, 'steps'>): number {
    return plan.steps.findIndex(step => !step.skip && step.status === 'pending');
}

/** The index of the step that is active now: running, waiting for the user, or failed. -1 when there is none. */
export function activeStepIndex(plan: Pick<Plan, 'steps'>): number {
    return plan.steps.findIndex(step => step.status === 'running' || step.status === 'attention' || step.status === 'failed');
}

/**
 * What Resume does with a plan:
 * - "advance": no step is active. The runner starts the next step.
 * - "continue": the active step stopped. The runner checks it again, or starts it again when it has no worktree.
 * - "check": the active step shows as running, but its agent is not working. The runner checks the worktree for a new
 *   commit now. This finishes a step that missed the end of the turn, for example when a save failed on a full disk.
 * - "wait": the agent of the running step is working. The end of its turn finishes the step.
 */
export type ResumeAction = { kind: 'advance' } | { kind: 'continue' | 'check' | 'wait'; stepId: string };

/** Returns what Resume does. `agentState` is the state of the agent of the active step, when ShipWarden knows it. */
export function resumeAction(plan: Pick<Plan, 'steps'>, agentState: AgentState | undefined): ResumeAction {
    const index = activeStepIndex(plan);
    if (index < 0) return { kind: 'advance' };
    const step = plan.steps[index];
    if (step.status !== 'running') return { kind: 'continue', stepId: step.id };
    // A step without a worktree is still making it. The runner finishes it.
    if (!step.worktreePath || agentState === 'working' || agentState === 'starting') return { kind: 'wait', stepId: step.id };
    return { kind: 'check', stepId: step.id };
}

/**
 * The branch that a new step worktree starts from: the branch of the nearest earlier step in the same repository that
 * has a branch. Undefined: the default branch. A step whose pull request merged is not a base: its work is in the base
 * of its pull request. `stack` is false when the plan does not stack.
 */
export function worktreeBaseOf(steps: readonly PlanStep[], index: number, stack = true): string | undefined {
    if (!stack) return undefined;
    const repo = steps[index]?.repo;
    for (let at = index - 1; at >= 0; at--) {
        const step = steps[at];
        if (step.repo === repo && step.branch && step.status === 'done' && !step.mergedAt) return step.branch;
    }
    return undefined;
}

/**
 * The target branch of the pull request of a step: the branch of the nearest earlier step in the same repository with
 * a pull request that did not merge. Undefined: the default branch. A branch without a pull request was not pushed, so
 * it cannot be a target. `stack` is false when the plan does not stack.
 */
export function pullRequestBaseOf(steps: readonly PlanStep[], index: number, stack = true): string | undefined {
    if (!stack) return undefined;
    const repo = steps[index]?.repo;
    for (let at = index - 1; at >= 0; at--) {
        const step = steps[at];
        if (step.repo === repo && step.pr && step.branch && !step.mergedAt) return step.branch;
    }
    return undefined;
}

/**
 * Returns why the step at `index` cannot start yet, or undefined. In a stack, a step starts only after the step that
 * it stacks on is done: that step then has its branch, and a step with a pull request pushed the branch.
 */
export function stackWait(plan: Pick<Plan, 'steps' | 'noStack'>, index: number): string | undefined {
    const parent = stackedOnIndex(plan.steps, index, !plan.noStack);
    if (parent < 0) return undefined;
    const step = plan.steps[parent];
    if (step.status === 'done' || step.status === 'skipped') return undefined;
    return `Waiting for step ${parent + 1} to push its branch.`;
}

/** A step to rebase after the pull request of a lower step merged. */
export interface RestackTarget {
    /** The index of the step to rebase. */
    index: number;
    /** The new base branch: the base of the merged pull request, for example "main". */
    onto: string;
}

/**
 * Returns the steps to rebase after the pull request of the step at `mergedIndex` merged: the steps of the same
 * repository whose pull request targets the merged branch. Each one gets the base of the merged pull request. A step
 * without a worktree cannot rebase, so it is not in the list.
 */
export function restackTargets(steps: readonly PlanStep[], mergedIndex: number): RestackTarget[] {
    const merged = steps[mergedIndex];
    if (!merged?.pr || !merged.branch) return [];
    const onto = merged.pr.base;
    return steps.flatMap((step, index) =>
        index !== mergedIndex && step.repo === merged.repo && step.pr?.base === merged.branch && !step.mergedAt && step.worktreePath ? [{ index, onto }] : []
    );
}

/**
 * The commits of the old base of a step for "git rebase --onto": the parent tip from when the step branched, and the
 * head of the merged pull request. Git uses the newest one that the branch contains.
 */
export function restackOldBases(step: Pick<PlanStep, 'stackBase'>, mergedHead: string | undefined): string[] {
    return [step.stackBase, mergedHead].filter((commit): commit is string => !!commit && COMMIT_HASH.test(commit));
}

/** Returns "KEY: title" or the title of a task link. */
function taskLabel(link: TaskLink): string {
    return link.key ? `${link.key}: ${link.title}` : link.title;
}

/** Returns the prompt for the agent of a step. `repoName` returns the name of a repository folder. */
export function stepPrompt(plan: Plan, index: number, repoName: (repo: string) => string): string {
    const step = plan.steps[index];
    const runnable = plan.steps.filter(item => !item.skip && item.status !== 'skipped');
    const list = plan.steps
        .map((item, at) => {
            if (item.skip || item.status === 'skipped') return undefined;
            const repo = item.repo ? repoName(item.repo) : 'no repository';
            const state =
                at === index
                    ? ' ← this step'
                    : item.status === 'done'
                      ? ` (done${item.pr ? `: ${item.pr.url}` : item.branch ? `, branch ${item.branch}` : ''})`
                      : '';
            return `${at + 1}. ${item.title} [${repo}]${state}`;
        })
        .filter(Boolean)
        .join('\n');
    const base = step.baseBranch
        ? `It starts from the branch "${step.baseBranch}", which has the work of the earlier step in this repository.`
        : 'It starts from the default branch.';
    const parts = [
        `You work on step ${runnable.indexOf(step) + 1} of ${runnable.length} of the plan "${plan.title}".`,
        `The idea of the plan:\n\n${quoted(plan.idea.trim() || plan.title)}`,
        ...(plan.summary ? [`The approach:\n\n${plan.summary.trim()}`] : []),
        ...(plan.decisions?.length ? [`The decisions of the plan. The user confirmed them:\n${plan.decisions.map(item => `- ${item.text}`).join('\n')}`] : []),
        `The steps:\n${list}`,
        `This step: ${step.title}\n\n${step.description.trim() || '(The step has no description. Use the title.)'}`
    ];
    if (step.task.kind === 'existing') {
        parts.push(`The task of this step: ${taskLabel(step.task.link)}${step.task.link.url ? ` (${step.task.link.url})` : ''}`);
    }
    parts.push(
        [
            `You are in a new git worktree of ${step.repo ? repoName(step.repo) : 'the repository'} on the branch "${step.branch}". ${base}`,
            'Do only the work of this step. Later steps do the rest.',
            'Make the change, run the tests and commit your work.',
            step.pullRequest
                ? 'Do not push and do not open a pull request. ShipWarden does that when you finish your turn.'
                : 'This step is an experiment. Do not push and do not open a pull request.'
        ].join('\n')
    );
    return parts.join('\n\n');
}

/** True when a step of the plan that runs opens a pull request. */
export function opensPullRequests(plan: Plan): boolean {
    return plan.steps.some(step => step.pullRequest && !step.skip && step.status !== 'skipped');
}

/** True when the agent of a step watches the CI checks of its pull request after the step is done. */
export function watchesCi(plan: Plan, step: PlanStep): boolean {
    return !!plan.keepAgents && !!plan.watchCi && !!step.pr;
}

/** Returns the prompt that tells the agent of a done step to watch the CI checks of its pull request. */
export function ciWatchPrompt(pr: StepPullRequest): string {
    return [
        `ShipWarden opened pull request #${pr.number} (${pr.url}) for your step.`,
        `Watch its CI checks until they finish. For a GitHub repository, run \`gh pr checks ${pr.number} --watch\`.`,
        'When a check fails, read its log and fix the problem. Run the tests and commit. Then push the branch, and watch the checks again.',
        'Stop when all checks pass. When you cannot fix a check, stop and tell the user why.'
    ].join('\n');
}

/** Returns the title of the pull request of a step. */
export function pullRequestTitle(step: PlanStep): string {
    const key = step.task.kind === 'existing' ? step.task.link.key : undefined;
    return key ? `${key}: ${step.title}` : step.title;
}

/**
 * Returns the body of the pull request of a step: the description, the task, and the merge order of the plan. A
 * pull request of another repository shows as its web address, so GitHub links it.
 */
export function pullRequestBody(plan: Plan, index: number, repoName: (repo: string) => string): string {
    const step = plan.steps[index];
    const parts = [step.description.trim()];
    if (step.task.kind === 'existing') {
        const link = step.task.link;
        parts.push(`Task: ${link.url ? `[${taskLabel(link)}](${link.url})` : taskLabel(link)}`);
    }
    const order = plan.steps
        .map((item, at) => {
            if (item.skip || item.status === 'skipped' || !item.pullRequest) return undefined;
            const repo = item.repo ? repoName(item.repo) : '';
            const ref = at === index ? '**this pull request**' : item.pr ? item.pr.url : '(not open yet)';
            return `${at + 1}. ${item.title} (${repo}): ${ref}`;
        })
        .filter(Boolean);
    parts.push(`---\n\nPart of the plan "${plan.title}". Merge in this order:\n\n${order.join('\n')}`);
    if (step.baseBranch && !step.pr && pullRequestBaseOf(plan.steps, index, !plan.noStack) !== step.baseBranch) {
        parts.push(`This branch starts from "${step.baseBranch}", an experiment step with no pull request. This pull request contains its commits too.`);
    }
    return parts.filter(Boolean).join('\n\n');
}

/** Counts the steps that will run, the pull requests and the new tasks. For the confirmation of "Execute plan". */
export function planCounts(plan: Pick<Plan, 'steps'>): { steps: number; pullRequests: number; newTasks: number; repos: number } {
    const active = plan.steps.filter(step => !step.skip);
    return {
        steps: active.length,
        pullRequests: active.filter(step => step.pullRequest).length,
        newTasks: active.filter(step => step.task.kind === 'new').length,
        repos: new Set(active.flatMap(step => (step.repo ? [step.repo] : []))).size
    };
}
