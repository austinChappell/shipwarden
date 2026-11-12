import { isAgentMode, type AgentMode } from './agent-modes';
import type { AgentProgram } from './agent-programs';
import { shellQuote } from './agents';
import { fence } from './ask-agent';
import type { TaskLink } from './tasks';

/**
 * Plans: an idea for a project, broken into steps. An agent reads all repositories of the project and proposes the
 * steps. The user edits the steps, and then executes the plan. Each step runs in its own worktree, one step after the
 * other. Steps in the same repository stack: each branch starts from the branch of the step before it.
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
    /** The summary of the agent, in Markdown. */
    summary?: string;
    steps: PlanStep[];
    status: PlanStatus;
    taskTarget?: PlanTaskTarget;
    /** The permission mode of the agents of the steps. Undefined: the mode of the agent in Settings › Agents. */
    agentMode?: AgentMode;
    /** True: the pull requests are drafts. */
    draftPullRequests: boolean;
    /** The name of the agent that wrote the last proposal. */
    agent?: string;
    createdAt: number;
    updatedAt: number;
    executedAt?: number;
    finishedAt?: number;
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
    steps: Pick<PlanStep, 'title' | 'description' | 'repo' | 'pullRequest'>[];
}

export const MAX_TITLE_LENGTH = 120;

/** The title of a new plan. The plan gets the title of its first step, or the title of the proposal of an agent. */
export const NEW_PLAN_TITLE = 'New plan';
const MAX_TEXT_LENGTH = 50_000;
const MAX_STEPS = 50;

export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
    pending: 'Not started',
    running: 'Agent works',
    attention: 'Needs you',
    done: 'Done',
    skipped: 'Skipped',
    failed: 'Failed'
};

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
        ...(plan.taskTarget ? { taskTarget: plan.taskTarget } : {}),
        ...(plan.agentMode ? { agentMode: plan.agentMode } : {}),
        draftPullRequests: plan.draftPullRequests,
        steps: plan.steps.map(step => ({
            id: newPlanId(),
            title: step.title,
            description: step.description,
            ...(step.repo ? { repo: step.repo } : {}),
            task: step.task.kind === 'existing' ? { kind: 'existing', link: step.task.link } : step.task,
            pullRequest: step.pullRequest,
            skip: step.skip || step.status === 'skipped',
            status: 'pending'
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
    for (const key of ['turnFrom', 'startedAt', 'finishedAt'] as const) {
        const value = time(raw[key]);
        if (value !== undefined) step[key] = value;
    }
    const pr = pullRequestOf(raw.pr);
    if (pr) step.pr = pr;
    return step;
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
        if (step && !steps.some(existing => existing.id === step.id) && steps.length < MAX_STEPS) steps.push(step);
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
    const connectionId = nonEmpty(target.connectionId, 200);
    const collectionId = nonEmpty(target.collectionId, 500);
    if (connectionId && collectionId) {
        plan.taskTarget = { connectionId, collectionId, ...(nonEmpty(target.collectionName, 500) ? { collectionName: target.collectionName as string } : {}) };
    }
    if (isAgentMode(raw.agentMode)) plan.agentMode = raw.agentMode;
    const agent = nonEmpty(raw.agent, 200);
    if (agent) plan.agent = agent;
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
 * that runs. Returns -1 when the step starts from the default branch.
 */
export function stackedOnIndex(steps: readonly PlanStep[], index: number): number {
    const step = steps[index];
    if (!step?.repo || step.skip) return -1;
    for (let at = index - 1; at >= 0; at--) {
        if (steps[at].repo === step.repo && !steps[at].skip) return at;
    }
    return -1;
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
    if (input.feedback?.trim()) {
        parts.push(`Change the plan with this feedback:\n\n${quoted(input.feedback.trim())}`);
    }
    parts.push(
        [
            'Read the code of the repositories that are related to the idea. Do not change files.',
            'Then propose a plan: a list of steps in the order to do them. Each step is one pull request in one repository.',
            'A step must be small enough for one agent session. A step in one repository can depend on an earlier step in the same repository or in a different repository.',
            'Write the description of each step as instructions for a coding agent: what to change, which files, and how to test it.',
            'Use the exact repository names from the list.',
            'Answer with a short summary in Markdown, and then one JSON code block with this form:',
            '```json\n{\n  "title": "A short title for the plan",\n  "summary": "Two or three sentences about the approach",\n  "steps": [\n    { "title": "A short title", "repo": "repository name", "description": "Markdown instructions", "pullRequest": true }\n  ]\n}\n```',
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
    const steps = list.slice(0, MAX_STEPS).flatMap(item => {
        const step = record(item);
        const title = nonEmpty(step.title, 1000)?.trim();
        if (!title) return [];
        const repo = matchRepo(typeof step.repo === 'string' ? step.repo : '', repos);
        return [
            {
                title: title.slice(0, MAX_TITLE_LENGTH),
                description: text(step.description) ?? '',
                ...(repo ? { repo } : {}),
                pullRequest: step.pullRequest !== false
            }
        ];
    });
    if (steps.length === 0) throw new Error('The plan of the agent has no steps. Explore again, or add the steps yourself.');
    const title = nonEmpty(raw.title, 1000)?.trim().slice(0, MAX_TITLE_LENGTH);
    const summary = nonEmpty(raw.summary);
    return { steps, ...(title ? { title } : {}), ...(summary ? { summary: summary.trim() } : {}) };
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

/** Replaces the steps of a draft with a proposal. The task choices of steps with the same title stay. */
export function applyProposal(plan: Plan, proposal: PlanProposal, agent: string, now: number): Plan {
    const steps = proposal.steps.map(item => {
        const before = plan.steps.find(step => step.title.trim().toLowerCase() === item.title.trim().toLowerCase());
        return { ...newStep(item.repo), ...item, ...(before ? { task: before.task, skip: before.skip } : {}) };
    });
    const keepTitle = plan.title !== NEW_PLAN_TITLE && plan.title.trim();
    return {
        ...plan,
        title: keepTitle ? plan.title : (proposal.title ?? plan.title),
        ...(proposal.summary ? { summary: proposal.summary } : {}),
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
    const short =
        plan.id
            .replace(/[^a-z0-9]/gi, '')
            .slice(-4)
            .toLowerCase() || 'plan';
    return `plan/${slug(plan.title, 32)}-${short}/${index + 1}-${slug(step.title, 40)}`;
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
 * The branch that a new step worktree starts from: the branch of the nearest earlier step in the same repository that
 * has a branch. Undefined: the default branch.
 */
export function worktreeBaseOf(steps: readonly PlanStep[], index: number): string | undefined {
    const repo = steps[index]?.repo;
    for (let at = index - 1; at >= 0; at--) {
        const step = steps[at];
        if (step.repo === repo && step.branch && step.status === 'done') return step.branch;
    }
    return undefined;
}

/**
 * The target branch of the pull request of a step: the branch of the nearest earlier step in the same repository with
 * a pull request. Undefined: the default branch. A branch without a pull request was not pushed, so it cannot be a target.
 */
export function pullRequestBaseOf(steps: readonly PlanStep[], index: number): string | undefined {
    const repo = steps[index]?.repo;
    for (let at = index - 1; at >= 0; at--) {
        const step = steps[at];
        if (step.repo === repo && step.pr && step.branch) return step.branch;
    }
    return undefined;
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
    if (step.baseBranch && !step.pr && pullRequestBaseOf(plan.steps, index) !== step.baseBranch) {
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
