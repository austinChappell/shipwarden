import type { AgentMode } from '@shared/agent-modes';
import type { AgentUpdate } from '@shared/agents';
import { hasDiverged } from '@shared/git';
import { pullRequestWebUrl, type BranchSummary, type MergedPullRequest } from '@shared/github';
import { pullRequestKnownClosed } from '@shared/plan-progress';
import type { NotificationSettings } from '@shared/notifications';
import {
    activeStepIndex,
    ciWatchPrompt,
    freeBranchName,
    nextStepIndex,
    planReview,
    pullRequestBaseOf,
    pullRequestBody,
    pullRequestTitle,
    restackOldBases,
    restackTargets,
    resumeAction,
    reviewText,
    stackWait,
    stepBranch,
    stepBranchTask,
    stepPrompt,
    worktreeBaseOf,
    watchesCi,
    type Plan,
    type PlanStep,
    type StepRestack
} from '@shared/plans';
import { restackConflictPrompt } from '@shared/rebase-conflict';
import type { ConnectionInfo, StartStatusResult, Task, TaskLink, TaskSource } from '@shared/tasks';
import type { TerminalSession } from '@shared/terminal';
import type { CreatedWorktree, Worktree } from '@shared/worktrees';
import { taskBranchName } from '../app/task-branch';
import { saveTaskLink } from '../app/task-links';
import { taskManagerKeys } from '../components/task-managers-cache';
import { gitChanged } from '../git/git-store';
import { cachedPullRequest } from '../github/pull-request-cache';
import { changePullRequest } from '../github/pull-request-mutations';
import { prependTask, taskQueryKeys } from '../components/tasks/task-view-logic';
import { keyRoots, queryClient } from '../query-client';
import { agentStateStore } from '../terminal/agent-state-store';
import { budgetWait } from '../usage-budget';
import { errorText } from '../util';
import { syncPlanGroup } from './plan-group';
import { cachedPlan, plansQuery, runnablePlans, updatePlan } from './plan-queries';

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
    /** Stops the agent of a terminal session and closes its tab. */
    stopAgent(session: TerminalSession): Promise<void>;
}

/** The newest state of the app. App gives it to the runner at each render. */
export interface RunnerContext {
    /** False until the plans and the settings loaded. The runner does nothing before. */
    ready: boolean;
    sessions: TerminalSession[];
    notifications: NotificationSettings;
    /** The branch template in Settings › Worktrees. Undefined: the steps use "plan/<plan>-<id>/<number>-<step>". */
    branchTemplate: string | undefined;
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
            // New pull request data in the cache can show a merge. The runner reads the cache and sends no request.
            queryClient.getQueryCache().subscribe(event => {
                if (event.type === 'updated' && event.action.type === 'success' && isMergeData(event.query.queryKey)) void this.restackMerged();
            });
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
        if (plan.coordinator) throw new Error('The plan is a coordinator run. Its agent starts the workers.');
        if (plan.status !== 'draft') throw new Error('The plan ran already. Duplicate it to run it again.');
        const review = planReview(plan);
        if (!review.complete) throw new Error(reviewText(review));
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

    /**
     * Continues a paused plan. A step that waits for the user is checked again. A running step whose agent is not
     * working is checked for a new commit, because the step possibly missed the end of the turn.
     */
    async resume(planId: string): Promise<void> {
        await updatePlan(planId, plan => (plan.status === 'paused' ? { ...plan, status: 'running' } : plan));
        const plan = cachedPlan(planId);
        if (!plan) return;
        const running = plan.steps.find(step => step.status === 'running');
        const agentState = running?.sessionId ? agentStateStore.getSnapshot().get(running.sessionId)?.state : undefined;
        const action = resumeAction(plan, agentState);
        if (action.kind === 'continue') await this.continueStep(planId, action.stepId);
        else if (action.kind === 'check') await this.finish(planId, action.stepId);
        else await this.advance(planId);
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
        await this.patchStep(planId, stepId, { status: 'running', sessionId: session.id, turnFrom, detail: 'The agent is working on the step.' });
    }

    /**
     * Gives more work to the agent of a done step, for example the review comments or the failed checks of its pull
     * request. The agent of the worktree gets the prompt. Without one, a new agent starts. The status of the step stays.
     */
    async followUp(planId: string, stepId: string, prompt: string, label: string): Promise<void> {
        const context = this.ready;
        if (!context) throw new Error('ShipWarden did not load the plans yet. Try again in a few seconds.');
        const plan = cachedPlan(planId);
        const step = plan?.steps.find(item => item.id === stepId);
        if (!plan || !step) throw new Error('The step does not exist anymore.');
        if (!step.worktreePath || !step.repo) throw new Error('The step has no worktree.');
        const session = await context.actions.promptAgent({ path: step.worktreePath }, prompt, {
            repoPath: step.repo,
            ...(plan.agentMode ? { mode: plan.agentMode } : {})
        });
        await this.patchStep(planId, stepId, { sessionId: session.id, followUp: { label, at: Date.now() } });
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
        for (const plan of runnablePlans()) {
            const step = plan.steps.find(item => (item.status === 'running' || item.status === 'attention') && item.sessionId === sessionId);
            if (step && update.at >= (step.turnFrom ?? 0)) void this.finish(plan.id, step.id);
        }
    }

    /** The timer: a step whose agent finished its turn finishes, and a running plan without an active step continues. */
    private async tick(): Promise<void> {
        const context = this.ready;
        if (!context) return;
        await queryClient.fetchQuery(plansQuery);
        await this.restackMerged();
        await this.checkRestacks();
        for (const plan of runnablePlans()) {
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

    /**
     * Returns the branch of a step. With a branch template in Settings › Worktrees, the branch uses the template, as
     * for a task that you start. Without a template, the branch is "plan/<plan>-<id>/<number>-<step>". A branch that
     * another step of the plan or the repository has already gets a number at the end.
     */
    private async branchName(plan: Plan, index: number, repo: string, template: string | undefined): Promise<string> {
        const step = plan.steps[index];
        if (!template?.trim()) return stepBranch(plan, step, index);
        const { branch } = await taskBranchName(stepBranchTask(plan, step, index), repo, template);
        const taken = plan.steps.filter(item => item.id !== step.id && item.branch).map(item => item.branch as string);
        try {
            const list = await api.worktrees.branches(repo);
            taken.push(...list.local);
            for (const remote of list.remote) {
                const owner = list.remotes.find(name => remote.startsWith(`${name}/`));
                taken.push(owner ? remote.slice(owner.length + 1) : remote);
            }
        } catch {
            // Without the list, the branch gets no number. When the branch exists, the worktree uses that branch.
        }
        return freeBranchName(branch, taken);
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
        // The usage budget of Settings › Agents stops a new agent. The step stays pending with the wait text, and the
        // timer tries again every 30 seconds. The text has the clock time only, so the plan file does not change each minute.
        const wait = budgetWait(undefined, repo);
        if (wait) {
            if (step.detail !== wait) await this.patchStep(plan.id, step.id, { detail: wait });
            return;
        }
        // In a stack, the step before must push its branch first. The runner tries again at the next tick.
        const waitForStack = stackWait(plan, index);
        if (waitForStack) {
            if (step.detail !== waitForStack) await this.patchStep(plan.id, step.id, { detail: waitForStack });
            return;
        }
        const baseBranch = worktreeBaseOf(plan.steps, index, !plan.noStack);
        // The old base for "git rebase --onto" is the tip of the branch that the pull request targets. A step that
        // starts from an experiment branch gets no old base, because that branch is not the target.
        const recordBase = !!baseBranch && baseBranch === pullRequestBaseOf(plan.steps, index, !plan.noStack);
        await this.patchStep(plan.id, step.id, { status: 'running', startedAt: Date.now(), detail: 'ShipWarden is making the branch name.' });
        const branch = await this.branchName(plan, index, repo, context.branchTemplate);
        await this.patchStep(plan.id, step.id, { branch, ...(baseBranch ? { baseBranch } : {}), detail: 'ShipWarden is making the worktree.' });
        let worktree: CreatedWorktree;
        try {
            worktree = await api.worktrees.create({ repoPath: repo, branch, ...(baseBranch ? { baseRef: baseBranch } : {}) });
        } catch (error) {
            // The branch possibly does not exist. A later step must not start from it.
            await this.patchStep(plan.id, step.id, { branch: undefined, baseBranch: undefined });
            await this.fail(plan, step, `The worktree was not made: ${errorText(error)}`);
            return;
        }
        await this.patchStep(plan.id, step.id, {
            worktreePath: worktree.path,
            startHead: worktree.head,
            ...(recordBase && worktree.head ? { stackBase: worktree.head } : {})
        });
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
            await this.patchStep(plan.id, step.id, { sessionId: session.id, turnFrom, detail: 'The agent is working on the step.' });
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
        if (changes?.rebase) {
            await this.attention(
                plan,
                step,
                'A rebase is in progress in the worktree. Continue or abort it in the Changes tab, then select Continue.',
                worktree.path
            );
            return;
        }
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
        if (step.pullRequest && !(await this.rebaseBeforePush(plan, index, worktree.path))) return;
        if (!step.pullRequest) {
            await this.patchStep(planId, stepId, { status: 'done', finishedAt: Date.now(), detail: `The agent committed the experiment.${notes}` });
            await this.afterStepDone(planId, stepId);
            return;
        }
        try {
            await this.patchStep(planId, stepId, { detail: 'ShipWarden is pushing the branch and opening the pull request.' });
            await api.git.push(worktree.path);
            const pr = await this.openPullRequest(plan, index, worktree.path);
            await this.patchStep(planId, stepId, { status: 'done', pr, finishedAt: Date.now(), detail: `Opened pull request #${pr.number}.${notes}` });
        } catch (error) {
            await this.fail(plan, step, `The pull request was not opened: ${errorText(error)} Correct the problem, then select "Try again".`);
            return;
        }
        // The PR group of the plan gets the new pull request. A problem with the group does not stop the plan.
        const latest = cachedPlan(planId);
        if (latest && !latest.noPrGroup) {
            await syncPlanGroup(latest).catch(error => console.warn(`[plans] The PR group of "${latest.title}" did not change: ${errorText(error)}`));
        }
        await this.afterStepDone(planId, stepId);
    }

    /**
     * Stops the agent of a step that the runner finished, as the settings of the plan tell. With "keep the agents",
     * the agent can watch the CI checks of the pull request. A problem here does not stop the plan.
     */
    private async afterStepDone(planId: string, stepId: string): Promise<void> {
        const context = this.ready;
        const plan = cachedPlan(planId);
        const step = plan?.steps.find(item => item.id === stepId);
        if (!context || !plan || !step) return;
        try {
            if (!plan.keepAgents) {
                const session = step.sessionId ? context.sessions.find(item => item.id === step.sessionId) : undefined;
                if (session && !session.exited) await context.actions.stopAgent(session);
            } else if (step.pr && watchesCi(plan, step)) {
                await this.followUp(planId, stepId, ciWatchPrompt(step.pr), `Watching the checks on #${step.pr.number}`);
            }
        } catch (error) {
            console.warn(`[plans] The agent of the step "${step.title}" did not stop or did not get the CI prompt: ${errorText(error)}`);
        }
    }

    /** Opens the pull request of a step. A pull request that the branch has already (for example from the agent) counts. */
    private async openPullRequest(plan: Plan, index: number, worktreePath: string): Promise<NonNullable<PlanStep['pr']>> {
        const context = this.ready;
        const repoLabel = context?.repoLabel ?? ((repo: string) => repo);
        const latest = cachedPlan(plan.id) ?? plan;
        const step = latest.steps[index];
        const base = pullRequestBaseOf(latest.steps, index, !latest.noStack);
        const existing = await api.github.status(worktreePath).catch(() => null);
        if (existing?.pullRequest?.state === 'OPEN') {
            const found = { number: existing.pullRequest.number, url: existing.pullRequest.url, base: existing.pullRequest.baseRefName };
            // A pull request that the agent opened can target the wrong branch. In a stack, it targets the step before.
            if (base && found.base !== base && step.repo) {
                await api.github.changePullRequest(step.repo, found.number, { kind: 'base', base });
                return { ...found, base };
            }
            return found;
        }
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
    /* Stacks                                                                                                          */
    /* -------------------------------------------------------------------------------------------------------------- */

    /** True while `restackMerged` runs. A second call in that time does nothing. */
    private restacking = false;
    /** The plans with a stack action that runs (see `stack-actions.ts`). `restackMerged` does not change them meanwhile. */
    private readonly held = new Set<string>();

    /**
     * Stops the automatic restack of a plan while a stack action runs. The stack action changes the same branches and
     * pull requests. `release` ends the hold and restacks the merged pull requests of the plan.
     */
    hold(planId: string): void {
        this.held.add(planId);
    }

    async release(planId: string): Promise<void> {
        this.held.delete(planId);
        await this.restackMerged();
    }

    /**
     * Finds the pull requests of stacked plans that merged, from the cached pull request data, and restacks the steps
     * above them. It sends no request: the data comes from the queries that the views and the automations load.
     */
    async restackMerged(): Promise<void> {
        if (!this.ready || this.restacking) return;
        this.restacking = true;
        try {
            for (const plan of runnablePlans()) {
                if (plan.noStack || plan.status === 'draft' || this.held.has(plan.id)) continue;
                for (const step of plan.steps) {
                    if (!step.pr || !step.branch || step.mergedAt) continue;
                    const merged = mergedHeadOf(step);
                    if (merged !== null) await this.restack(plan.id, step.id, merged);
                }
            }
        } finally {
            this.restacking = false;
        }
    }

    /**
     * The pull request of a step merged. Each step whose pull request targets the merged branch gets a rebase onto the
     * base of the merged pull request, and its pull request gets that base. `mergedHead` is the head commit of the
     * merged pull request, when it is known.
     */
    private async restack(planId: string, stepId: string, mergedHead: string | undefined): Promise<void> {
        await this.patchStep(planId, stepId, { mergedAt: Date.now() });
        const plan = cachedPlan(planId);
        const index = plan?.steps.findIndex(step => step.id === stepId) ?? -1;
        const merged = plan?.steps[index];
        if (!plan || !merged?.pr) return;
        for (const target of restackTargets(plan.steps, index)) {
            const child = plan.steps[target.index];
            // A pull request that merged or closed needs no rebase, for example in a plan that ran before stacks restacked.
            const open = child.repo ? queryClient.getQueryData<Record<string, BranchSummary>>([...keyRoots.branchSummaries, child.repo]) : undefined;
            if (mergedHeadOf(child) !== null || pullRequestKnownClosed(child, open)) continue;
            await this.restackStep(planId, child.id, {
                onto: target.onto,
                state: 'failed',
                merged: merged.pr.number,
                oldBases: restackOldBases(child, mergedHead)
            });
        }
    }

    /** Tries the rebase of a step again after it did not start. */
    async retryRestack(planId: string, stepId: string): Promise<void> {
        const restack = cachedPlan(planId)?.steps.find(step => step.id === stepId)?.restack;
        if (restack) await this.restackStep(planId, stepId, restack);
    }

    /**
     * Rebases the branch of a step onto `restack.onto` with "git rebase --onto", and changes the base of its pull
     * request. ShipWarden does not push: the user confirms the push with "--force-with-lease". A conflict goes to the
     * agent of the worktree, and the agent pushes after it resolves the conflict.
     */
    private async restackStep(planId: string, stepId: string, restack: StepRestack): Promise<void> {
        const key = `restack:${planId}:${stepId}`;
        if (this.busy.has(key)) return;
        this.busy.add(key);
        try {
            const plan = cachedPlan(planId);
            const step = plan?.steps.find(item => item.id === stepId);
            if (!plan || !step?.worktreePath || !step.pr || !step.repo) return;
            const { onto, merged } = restack;
            // A rebase under a working agent can mix with its edits. The user selects Rebase when the agent stops.
            const agent = step.sessionId ? agentStateStore.getSnapshot().get(step.sessionId)?.state : undefined;
            if (agent === 'working' || agent === 'starting') {
                const text = `#${merged} merged. The agent of the step is working, so ShipWarden did not rebase the branch onto ${onto}. Select Rebase when the agent stops.`;
                await this.patchStep(planId, stepId, { restack: { ...restack, state: 'failed' }, detail: text });
                this.notify(`"${step.title}" needs a rebase`, text, step.worktreePath);
                return;
            }
            // Undefined: the rebase changed nothing, so nothing waits.
            let state: StepRestack['state'] | undefined;
            let detail: string;
            try {
                const result = await api.git.rebase(step.worktreePath, onto, restack.oldBases ?? []).finally(gitChanged);
                if (result.status === 'conflict') {
                    state = 'conflict';
                    detail = `#${merged} merged. The rebase onto ${onto} stopped on a conflict.`;
                } else if (result.changed) {
                    state = 'push';
                    detail = `#${merged} merged. ShipWarden rebased the branch onto ${onto}. Push it to update #${step.pr.number}.`;
                } else {
                    detail = `#${merged} merged. The branch already has all commits of ${onto}.`;
                }
            } catch (error) {
                const text = `#${merged} merged, but the rebase onto ${onto} did not start: ${errorText(error)}`;
                await this.patchStep(planId, stepId, { restack: { ...restack, state: 'failed' }, detail: text });
                this.notify(`"${step.title}" needs a rebase`, text, step.worktreePath);
                return;
            }
            const retargeted = await this.retarget(step, onto);
            if (!retargeted) detail += ` Change the base of #${step.pr.number} to ${onto} by hand.`;
            await this.patchStep(planId, stepId, {
                restack: state ? { ...restack, state } : undefined,
                detail,
                ...(retargeted ? { pr: { ...step.pr, base: onto } } : {})
            });
            if (state === 'conflict') await this.sendRestackConflict(planId, stepId, merged);
            else if (state) this.notify(`"${step.title}" was rebased onto ${onto}`, detail, step.worktreePath);
        } finally {
            this.busy.delete(key);
        }
    }

    /** Points the pull request of a step at a new base branch. Returns false when the host refused the change. */
    private async retarget(step: PlanStep, base: string): Promise<boolean> {
        if (!step.pr || !step.repo) return false;
        if (step.pr.base === base) return true;
        try {
            const cached = cachedPullRequest(queryClient, step.pr.url);
            if (cached) await changePullRequest(step.repo, cached, { kind: 'base', base });
            else await api.github.changePullRequest(step.repo, step.pr.number, { kind: 'base', base });
            return true;
        } catch (error) {
            console.warn(`[plans] The base of #${step.pr.number} did not change to ${base}: ${errorText(error)}`);
            return false;
        }
    }

    /** Sends the rebase conflict of a step to the agent of its worktree. The usage budget can stop a new agent. */
    private async sendRestackConflict(planId: string, stepId: string, merged: number): Promise<void> {
        const plan = cachedPlan(planId);
        const step = plan?.steps.find(item => item.id === stepId);
        if (!plan || !step?.worktreePath || !step.pr) return;
        const wait = budgetWait(undefined, step.repo);
        const stopped = (why: string) => {
            const text = `${step.detail ?? ''} ${why} Resolve the conflict in the Changes tab, then push the branch.`.trim();
            void this.patchStep(planId, stepId, { detail: text });
            this.notify(`"${step.title}" has a rebase conflict`, text, step.worktreePath);
        };
        if (wait) {
            stopped(`The agent did not start: ${wait}.`);
            return;
        }
        try {
            const input = await api.git.rebaseConflict(step.worktreePath);
            await this.followUp(planId, stepId, restackConflictPrompt(input, step.pr, merged), `Resolving the rebase conflict of #${step.pr.number}`);
        } catch (error) {
            stopped(`The agent did not get the conflict: ${errorText(error)}`);
        }
    }

    /**
     * Checks the steps with a rebase that waits: a branch that has no rebase in progress and is the same as its
     * upstream was pushed, so the rebase is complete. A conflict that is resolved but not pushed waits for the push.
     * It runs local git only.
     */
    private async checkRestacks(): Promise<void> {
        for (const plan of runnablePlans()) {
            for (const step of plan.steps) {
                const restack = step.restack;
                if (!restack || restack.state === 'failed' || !step.worktreePath || this.busy.has(`restack:${plan.id}:${step.id}`)) continue;
                const changes = await api.git.changes(step.worktreePath).catch(() => undefined);
                if (!changes || changes.rebase) continue;
                if (changes.upstream && changes.ahead === 0 && changes.behind === 0) {
                    await this.restackPushed(plan.id, step.id);
                } else if (restack.state === 'conflict' && hasDiverged(changes)) {
                    await this.patchStep(plan.id, step.id, {
                        restack: { ...restack, state: 'push' },
                        detail: `The rebase onto ${restack.onto} is complete. Push the branch to update #${step.pr?.number}.`
                    });
                }
            }
        }
    }

    /** The rebased branch of a step was pushed. */
    async restackPushed(planId: string, stepId: string): Promise<void> {
        const step = cachedPlan(planId)?.steps.find(item => item.id === stepId);
        if (!step?.restack) return;
        await this.patchStep(planId, stepId, { restack: undefined, detail: `Rebased onto ${step.restack.onto} after #${step.restack.merged} merged.` });
    }

    /**
     * Before the first push of a step: when the step that it started from merged meanwhile, the branch moves onto the
     * base of that pull request with "git rebase --onto". Then the new pull request contains only the commits of the
     * step. Returns false when the step must wait, for example for a conflict.
     */
    private async rebaseBeforePush(plan: Plan, index: number, worktreePath: string): Promise<boolean> {
        const step = plan.steps[index];
        if (plan.noStack || !step.baseBranch || step.pr) return true;
        const parent = plan.steps.find(item => item.branch === step.baseBranch && item.repo === step.repo);
        if (!parent?.mergedAt) return true;
        const newBase = pullRequestBaseOf(plan.steps, index);
        // The user resolved the conflict of an earlier try. The rebase is complete.
        if (step.restack?.state === 'conflict') {
            await this.patchStep(plan.id, step.id, { restack: undefined, stackBase: undefined, baseBranch: newBase });
            return true;
        }
        const mergedPr = parent.pr;
        if (!mergedPr) return true;
        const onto = mergedPr.base;
        await this.patchStep(plan.id, step.id, { detail: `#${mergedPr.number} merged. ShipWarden is rebasing the branch onto ${onto}.` });
        try {
            const result = await api.git.rebase(worktreePath, onto, restackOldBases(step, mergedHeadOf(parent) ?? undefined)).finally(gitChanged);
            if (result.status === 'conflict') {
                await this.patchStep(plan.id, step.id, { restack: { onto, state: 'conflict', merged: mergedPr.number } });
                await this.attention(
                    plan,
                    step,
                    `#${mergedPr.number} merged, and the rebase onto ${onto} stopped on a conflict. Resolve it in the Changes tab, or send it to the agent there. Then select Continue.`,
                    worktreePath
                );
                return false;
            }
        } catch (error) {
            await this.attention(plan, step, `#${mergedPr.number} merged, but the rebase onto ${onto} did not work: ${errorText(error)}`, worktreePath);
            return false;
        }
        await this.patchStep(plan.id, step.id, { stackBase: undefined, baseBranch: newBase });
        return true;
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

    /** The step stopped. The plan does not continue until the user acts. */
    private async attention(plan: Plan, step: PlanStep, detail: string, worktreePath?: string): Promise<void> {
        await this.patchStep(plan.id, step.id, { status: 'attention', detail });
        this.notify(`"${step.title}" stopped`, detail, worktreePath ?? step.worktreePath, step.sessionId);
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

/** True for the query keys whose data can show a merged pull request: the merged branches and the pull request details. */
function isMergeData(queryKey: readonly unknown[]): boolean {
    return [keyRoots.mergedBranches, keyRoots.pullRequest].some(root => root.every((part, at) => queryKey[at] === part));
}

/**
 * Returns the head commit of the merged pull request of a step, from the cache. Returns undefined for a merge with an
 * unknown head commit, and null when the cache does not show a merge.
 */
function mergedHeadOf(step: PlanStep): string | undefined | null {
    if (!step.pr || !step.branch || !step.repo) return null;
    const merged = queryClient.getQueryData<Record<string, MergedPullRequest>>([...keyRoots.mergedBranches, step.repo])?.[step.branch];
    if (merged?.number === step.pr.number) return merged.headSha || undefined;
    const pr = cachedPullRequest(queryClient, step.pr.url);
    return pr?.state === 'MERGED' ? pr.headRefOid || undefined : null;
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
