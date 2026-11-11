import type { AgentMode } from '@shared/agent-modes';
import type { AgentUpdate } from '@shared/agents';
import { pullRequestWebUrl } from '@shared/github';
import type { NotificationSettings } from '@shared/notifications';
import {
    activeStepIndex,
    nextStepIndex,
    pullRequestBaseOf,
    pullRequestBody,
    pullRequestTitle,
    stepBranch,
    stepPrompt,
    worktreeBaseOf,
    type Plan,
    type PlanStep
} from '@shared/plans';
import type { ConnectionInfo, StartStatusResult, Task, TaskLink, TaskSource } from '@shared/tasks';
import type { TerminalSession } from '@shared/terminal';
import type { CreatedWorktree, Worktree } from '@shared/worktrees';
import { saveTaskLink } from '../app/task-links';
import { taskManagerKeys } from '../components/task-managers-cache';
import { prependTask, taskQueryKeys } from '../components/tasks/task-view-logic';
import { keyRoots, queryClient } from '../query-client';
import { agentStateStore } from '../terminal/agent-state-store';
import { errorText } from '../util';
import { cachedPlan, cachedPlans, plansQuery, updatePlan } from './plan-queries';

const api = window.shipwarden;

/** The runner checks the steps that run at this interval. It finds a finished turn that it did not get as an event. */
const TICK_MS = 30_000;
/** The start of a turn is a little before the prompt. This covers the clocks of the agent and the app. */
const TURN_MARGIN_MS = 2000;

/** The functions of the app that the runner uses. They do not show dialogs or banners. They throw an error with a message. */
export interface RunnerActions {
    promptAgent(
        worktree: Pick<Worktree, 'path'>,
        prompt: string,
        target?: { sessionId?: string; agentId?: string; repoPath?: string; mode?: AgentMode }
    ): Promise<TerminalSession>;
    prepareWorktree(repoPath: string, worktree: CreatedWorktree): Promise<void>;
    refreshWorktrees(repo: string): Promise<Worktree[]>;
    moveTaskToStatus(task: Task, connectionId: string, status: string): Promise<StartStatusResult>;
}

/** The newest state of the app. App gives it to the runner at each render. */
export interface RunnerContext {
    /** False until the plans and the settings loaded. The runner does nothing before. */
    ready: boolean;
    sessions: TerminalSession[];
    notifications: NotificationSettings;
    repoLabel(repo: string): string;
    actions: RunnerActions;
}

/**
 * Executes the plans while the app is open. A plan runs one step at a time. For each step, the runner makes a
 * worktree, links the task, and gives the step to a new agent. When the agent ends its turn with a new commit, the
 * runner pushes the branch, opens the pull request, and starts the next step. A step without a commit waits for the user.
 *
 * The state of each step is in the plan file, so a restart continues where the plan stopped.
 */
export class PlanRunner {
    private context: RunnerContext | undefined;
    /** The plans that the runner changes now. A second call for the same plan does nothing. */
    private readonly busy = new Set<string>();
    private timer: ReturnType<typeof setInterval> | undefined;

    /** Gives the runner the newest state of the app. The first ready state starts the timer. */
    setContext(context: RunnerContext): void {
        this.context = context;
        if (context.ready && !this.timer) {
            this.timer = setInterval(() => void this.tick(), TICK_MS);
            void this.tick();
        }
    }

    private get ready(): RunnerContext | undefined {
        return this.context?.ready ? this.context : undefined;
    }

    /* -------------------------------------------------------------------------------------------------------------- */
    /* User actions                                                                                                    */
    /* -------------------------------------------------------------------------------------------------------------- */

    /** Starts a draft plan: makes the new tasks, and starts the first step. Throws an error with a message. */
    async execute(planId: string): Promise<void> {
        if (!this.ready) throw new Error('ShipWarden did not load the plans yet. Try again in a few seconds.');
        const plan = cachedPlan(planId);
        if (!plan) throw new Error('The plan does not exist anymore.');
        if (plan.status !== 'draft') throw new Error('The plan ran already. Duplicate it to run it again.');
        await this.createTasks(plan);
        await updatePlan(planId, current => ({
            ...current,
            status: 'running',
            executedAt: Date.now(),
            steps: current.steps.map(step => (step.skip ? { ...step, status: 'skipped' } : step))
        }));
        await this.advance(planId);
    }

    /** Stops the plan after the current step. The agent of the current step continues its turn. */
    async pause(planId: string): Promise<void> {
        await updatePlan(planId, plan => (plan.status === 'running' ? { ...plan, status: 'paused' } : plan));
    }

    /** Continues a paused plan. A step that waits for the user is checked again. */
    async resume(planId: string): Promise<void> {
        await updatePlan(planId, plan => (plan.status === 'paused' ? { ...plan, status: 'running' } : plan));
        const plan = cachedPlan(planId);
        const active = plan ? activeStepIndex(plan) : -1;
        if (plan && active >= 0 && plan.steps[active].status !== 'running') {
            await this.continueStep(planId, plan.steps[active].id);
        } else {
            await this.advance(planId);
        }
    }

    /**
     * Checks a step again after the user helped: a new commit finishes the step. A failed step without a worktree
     * starts again.
     */
    async continueStep(planId: string, stepId: string): Promise<void> {
        const plan = cachedPlan(planId);
        const index = plan?.steps.findIndex(step => step.id === stepId) ?? -1;
        if (!plan || index < 0) return;
        const step = plan.steps[index];
        if (!step.worktreePath) {
            await this.patchStep(planId, stepId, { status: 'pending', detail: undefined });
            await this.advance(planId);
            return;
        }
        await this.finish(planId, stepId);
    }

    /** Sends the prompt of the step to the agent of its worktree again. For a prompt that did not get to the agent. */
    async resendPrompt(planId: string, stepId: string): Promise<void> {
        const context = this.ready;
        const plan = cachedPlan(planId);
        const index = plan?.steps.findIndex(step => step.id === stepId) ?? -1;
        if (!context || !plan || index < 0) return;
        const step = plan.steps[index];
        if (!step.worktreePath || !step.repo) throw new Error('The step has no worktree.');
        const turnFrom = Date.now() - TURN_MARGIN_MS;
        const session = await context.actions.promptAgent({ path: step.worktreePath }, stepPrompt(plan, index, context.repoLabel), {
            repoPath: step.repo,
            ...(plan.agentMode ? { mode: plan.agentMode } : {})
        });
        await this.patchStep(planId, stepId, { status: 'running', sessionId: session.id, turnFrom, detail: 'The agent works on the step.' });
    }

    /** Marks a step as done without a check, and starts the next step. The step gets no pull request. */
    async markDone(planId: string, stepId: string): Promise<void> {
        await this.patchStep(planId, stepId, { status: 'done', finishedAt: Date.now(), detail: 'You marked the step as done.' });
        await this.advance(planId);
    }

    /** Skips a step that did not finish, and starts the next step. Its worktree stays. */
    async skipStep(planId: string, stepId: string): Promise<void> {
        await this.patchStep(planId, stepId, { status: 'skipped', skip: true, finishedAt: Date.now(), detail: 'You skipped the step.' });
        await this.advance(planId);
    }

    /* -------------------------------------------------------------------------------------------------------------- */
    /* Events                                                                                                          */
    /* -------------------------------------------------------------------------------------------------------------- */

    /**
     * A new agent state. The end of the turn of a step agent finishes the step. A step that waits for the user is
     * checked again too: the user can answer the agent in its tab, and the agent can then commit.
     */
    onAgentState(sessionId: string, update: AgentUpdate): void {
        if (!this.ready || (update.state !== 'done' && update.state !== 'exited')) return;
        for (const plan of cachedPlans()) {
            const step = plan.steps.find(item => (item.status === 'running' || item.status === 'attention') && item.sessionId === sessionId);
            if (step && update.at >= (step.turnFrom ?? 0)) void this.finish(plan.id, step.id);
        }
    }

    /** The timer: a step whose agent finished its turn finishes, and a running plan without an active step continues. */
    private async tick(): Promise<void> {
        const context = this.ready;
        if (!context) return;
        await queryClient.fetchQuery(plansQuery);
        for (const plan of cachedPlans()) {
            if (plan.status !== 'running' && plan.status !== 'paused') continue;
            const running = plan.steps.find(step => step.status === 'running');
            if (running?.sessionId) {
                const state = agentStateStore.getSnapshot().get(running.sessionId);
                const session = context.sessions.find(item => item.id === running.sessionId);
                // Only "done" counts. A new agent can be "idle" before it gets the prompt.
                const ended = state?.state === 'done' && state.at >= (running.turnFrom ?? 0);
                // A session that the page does not know after a restart cannot report its turn. The user selects Continue.
                if (ended || session?.exited) await this.finish(plan.id, running.id);
            } else if (plan.status === 'running' && activeStepIndex(plan) < 0) {
                await this.advance(plan.id);
            }
        }
    }

    /* -------------------------------------------------------------------------------------------------------------- */
    /* Steps                                                                                                           */
    /* -------------------------------------------------------------------------------------------------------------- */

    /** Starts the next step of a running plan, or marks the plan as done. Does nothing while a step is active. */
    private async advance(planId: string): Promise<void> {
        if (this.busy.has(planId)) return;
        this.busy.add(planId);
        try {
            const plan = cachedPlan(planId);
            if (plan?.status !== 'running' || activeStepIndex(plan) >= 0) return;
            const index = nextStepIndex(plan);
            if (index < 0) {
                await updatePlan(planId, current => ({ ...current, status: 'done', finishedAt: Date.now() }));
                const last = [...plan.steps].reverse().find(step => step.worktreePath);
                this.notify(`The plan "${plan.title}" is done`, summaryLine(plan), last?.worktreePath);
                return;
            }
            await this.startStep(plan, index);
        } finally {
            this.busy.delete(planId);
        }
    }

    /** Makes the worktree of a step, links its task, and gives the step to a new agent. */
    private async startStep(plan: Plan, index: number): Promise<void> {
        const context = this.ready;
        if (!context) return;
        const step = plan.steps[index];
        const repo = step.repo;
        if (!repo) {
            await this.fail(plan, step, 'The step has no repository. Skip the step, or duplicate the plan and select a repository.');
            return;
        }
        const branch = stepBranch(plan, step, index);
        const baseBranch = worktreeBaseOf(plan.steps, index);
        await this.patchStep(plan.id, step.id, {
            status: 'running',
            branch,
            ...(baseBranch ? { baseBranch } : {}),
            startedAt: Date.now(),
            detail: 'ShipWarden makes the worktree.'
        });
        let worktree: CreatedWorktree;
        try {
            worktree = await api.worktrees.create({ repoPath: repo, branch, ...(baseBranch ? { baseRef: baseBranch } : {}) });
        } catch (error) {
            // The branch possibly does not exist. A later step must not start from it.
            await this.patchStep(plan.id, step.id, { branch: undefined, baseBranch: undefined });
            await this.fail(plan, step, `The worktree was not made: ${errorText(error)}`);
            return;
        }
        await this.patchStep(plan.id, step.id, { worktreePath: worktree.path, startHead: worktree.head });
        try {
            await context.actions.prepareWorktree(repo, worktree);
            if (step.task.kind === 'existing') {
                await saveTaskLink(queryClient, worktree.path, step.task.link);
                void this.moveTaskToStart(step.task.link);
            }
            await context.actions.refreshWorktrees(repo);
            const latest = cachedPlan(plan.id) ?? plan;
            const turnFrom = Date.now() - TURN_MARGIN_MS;
            const session = await context.actions.promptAgent(worktree, stepPrompt(latest, index, context.repoLabel), {
                repoPath: repo,
                ...(plan.agentMode ? { mode: plan.agentMode } : {})
            });
            await this.patchStep(plan.id, step.id, { sessionId: session.id, turnFrom, detail: 'The agent works on the step.' });
        } catch (error) {
            // The worktree exists. The user can help the agent and send the prompt again.
            await this.attention(plan, step, `The prompt did not get to the agent: ${errorText(error)}`, worktree.path);
        }
    }

    /**
     * Finishes a step after the agent ended its turn: a new commit opens the pull request and starts the next step.
     * Without a new commit, the step waits for the user.
     */
    private async finish(planId: string, stepId: string): Promise<void> {
        const key = `${planId}:${stepId}`;
        if (this.busy.has(key)) return;
        this.busy.add(key);
        try {
            await this.finishStep(planId, stepId);
        } finally {
            this.busy.delete(key);
        }
        await this.advance(planId);
    }

    private async finishStep(planId: string, stepId: string): Promise<void> {
        const context = this.ready;
        const plan = cachedPlan(planId);
        const index = plan?.steps.findIndex(step => step.id === stepId) ?? -1;
        if (!context || !plan || index < 0) return;
        const step = plan.steps[index];
        if (step.status === 'done' || step.status === 'skipped' || !step.repo || !step.worktreePath) return;
        const repo = step.repo;
        const worktree = (await api.worktrees.list(repo).catch((): Worktree[] => [])).find(item => item.path === step.worktreePath);
        if (!worktree) {
            await this.fail(plan, step, 'The worktree does not exist anymore. Skip the step, or mark it as done.');
            return;
        }
        const changes = await api.git.changes(worktree.path).catch(() => undefined);
        const dirty = !!changes && changes.staged.length + changes.unstaged.length + changes.conflicted.length > 0;
        if (worktree.head === step.startHead) {
            await this.attention(
                plan,
                step,
                dirty
                    ? 'The agent ended its turn with changes that are not committed. Ask the agent to commit, or commit the changes yourself. Then select Continue.'
                    : 'The agent ended its turn with no new commit. Answer the agent in its tab, then select Continue. Select "Mark done" when the step needs no change.',
                worktree.path
            );
            return;
        }
        const notes = dirty ? ' Some changes in the worktree are not committed. The pull request does not contain them.' : '';
        if (!step.pullRequest) {
            await this.patchStep(planId, stepId, { status: 'done', finishedAt: Date.now(), detail: `The agent committed the experiment.${notes}` });
            return;
        }
        try {
            await this.patchStep(planId, stepId, { detail: 'ShipWarden pushes the branch and opens the pull request.' });
            await api.git.push(worktree.path);
            const pr = await this.openPullRequest(plan, index, worktree.path);
            await this.patchStep(planId, stepId, { status: 'done', pr, finishedAt: Date.now(), detail: `Opened pull request #${pr.number}.${notes}` });
        } catch (error) {
            await this.fail(plan, step, `The pull request was not opened: ${errorText(error)} Correct the problem, then select "Try again".`);
        }
    }

    /** Opens the pull request of a step. A pull request that the branch has already (for example from the agent) counts. */
    private async openPullRequest(plan: Plan, index: number, worktreePath: string): Promise<NonNullable<PlanStep['pr']>> {
        const context = this.ready;
        const repoLabel = context?.repoLabel ?? ((repo: string) => repo);
        const existing = await api.github.status(worktreePath).catch(() => null);
        if (existing?.pullRequest?.state === 'OPEN') {
            return { number: existing.pullRequest.number, url: existing.pullRequest.url, base: existing.pullRequest.baseRefName };
        }
        const latest = cachedPlan(plan.id) ?? plan;
        const step = latest.steps[index];
        const base = pullRequestBaseOf(latest.steps, index);
        const number = await api.github.createPullRequest(worktreePath, {
            title: pullRequestTitle(step),
            body: pullRequestBody(latest, index, repoLabel),
            ...(base ? { base } : {}),
            draft: latest.draftPullRequests
        });
        void queryClient.invalidateQueries({ queryKey: [...keyRoots.branchStatus, worktreePath] });
        const status = await api.github.status(worktreePath).catch(() => null);
        if (status?.pullRequest?.number === number) {
            return { number, url: status.pullRequest.url, base: status.pullRequest.baseRefName };
        }
        const remote = await api.github.repoOf(worktreePath).catch(() => null);
        return { number, url: remote ? pullRequestWebUrl(remote, number) : `#${number}`, base: base ?? 'the default branch' };
    }

    /* -------------------------------------------------------------------------------------------------------------- */
    /* Tasks                                                                                                           */
    /* -------------------------------------------------------------------------------------------------------------- */

    /** Makes a task for each step with a "new" task, in the collection of the plan. Each new task links to its step at once. */
    private async createTasks(plan: Plan): Promise<void> {
        const steps = plan.steps.filter(step => !step.skip && step.task.kind === 'new');
        if (steps.length === 0) return;
        const target = plan.taskTarget;
        if (!target) throw new Error('Select a task manager and a collection for the new tasks.');
        const source = await queryClient.fetchQuery<TaskSource>({
            queryKey: taskQueryKeys.source(target.connectionId),
            queryFn: () => api.tasks.source(target.connectionId)
        });
        for (const step of steps) {
            const created = (await api.tasks.request(target.connectionId, 'tasks/create', {
                collection: target.collectionId,
                title: step.title,
                ...(step.description.trim() ? { description: step.description } : {})
            })) as Task;
            // The Tasks view shows the new task without a new request.
            queryClient.setQueriesData<Task[]>({ queryKey: [...keyRoots.tasks, 'list', target.connectionId, target.collectionId] }, list =>
                list ? prependTask(list, created) : list
            );
            const link: TaskLink = {
                connectionId: target.connectionId,
                pluginId: source.pluginId,
                taskId: created.id,
                title: created.title,
                ...(created.key ? { key: created.key } : {}),
                ...(created.url ? { url: created.url } : {})
            };
            await this.patchStep(plan.id, step.id, { task: { kind: 'existing', link, created: true } });
        }
    }

    /** Moves the task to the start status of its task manager (Settings › Task managers). A failure only logs a warning. */
    private async moveTaskToStart(link: TaskLink): Promise<void> {
        const context = this.ready;
        const connectionId = link.connectionId ?? link.pluginId;
        try {
            const connections = await queryClient.fetchQuery<ConnectionInfo[]>({
                queryKey: taskManagerKeys.allConnections,
                queryFn: () => api.tasks.connections()
            });
            const wanted = connections.find(item => item.id === connectionId)?.startStatus;
            if (!wanted || !context) return;
            const task = (await api.tasks.request(connectionId, 'tasks/get', { id: link.taskId })) as Task;
            await context.actions.moveTaskToStatus(task, connectionId, wanted);
        } catch (error) {
            console.warn(`[plans] ${link.key ?? link.title} did not move to the start status: ${errorText(error)}`);
        }
    }

    /* -------------------------------------------------------------------------------------------------------------- */
    /* State                                                                                                           */
    /* -------------------------------------------------------------------------------------------------------------- */

    private async patchStep(planId: string, stepId: string, patch: Partial<PlanStep>): Promise<void> {
        await updatePlan(planId, plan => ({
            ...plan,
            steps: plan.steps.map(step => {
                if (step.id !== stepId) return step;
                const next: PlanStep = { ...step, ...patch };
                // An undefined value in the patch removes the field.
                for (const key of Object.keys(patch) as (keyof PlanStep)[]) {
                    if (patch[key] === undefined) delete next[key];
                }
                return next;
            })
        }));
    }

    /** The step needs the user. The plan does not continue until the user acts. */
    private async attention(plan: Plan, step: PlanStep, detail: string, worktreePath?: string): Promise<void> {
        await this.patchStep(plan.id, step.id, { status: 'attention', detail });
        this.notify(`"${step.title}" needs you`, detail, worktreePath ?? step.worktreePath, step.sessionId);
    }

    private async fail(plan: Plan, step: PlanStep, detail: string): Promise<void> {
        await this.patchStep(plan.id, step.id, { status: 'failed', detail });
        this.notify(`"${step.title}" failed`, detail, step.worktreePath);
    }

    /** Shows a notification when Settings › Notifications allows the "Automations" event. A click opens the worktree. */
    private notify(title: string, body: string, worktreePath?: string, sessionId?: string): void {
        const settings = this.context?.notifications;
        if (!settings?.enabled) return;
        const event = settings.events.automation;
        if (!event.enabled || (!settings.whenFocused && document.hasFocus())) return;
        api.notifications.show({
            title,
            body: body.slice(0, 300),
            sound: event.sound,
            ...(worktreePath ? { target: { view: 'worktree' as const, worktreePath, ...(sessionId ? { sessionId } : {}) } } : {})
        });
    }
}

/** "3 pull requests, 1 experiment, 1 skipped". */
function summaryLine(plan: Plan): string {
    const done = plan.steps.filter(step => step.status === 'done');
    const prs = done.filter(step => step.pr).length;
    const others = done.length - prs;
    const skipped = plan.steps.filter(step => step.status === 'skipped').length;
    return [`${prs} pull ${prs === 1 ? 'request' : 'requests'}`, others ? `${others} without a pull request` : '', skipped ? `${skipped} skipped` : '']
        .filter(Boolean)
        .join(', ');
}

export const planRunner = new PlanRunner();
