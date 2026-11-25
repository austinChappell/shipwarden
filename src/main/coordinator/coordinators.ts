import { basename } from 'path';
import { canSetModel, commandSetsModel } from '@shared/agent-models';
import { agentProgramOf } from '@shared/agent-programs';
import {
    applyObservation,
    applyReport,
    coordinatorPlanOf,
    coordinatorPlans,
    depthError,
    depthOf,
    isWorkerOpen,
    MAX_WORKER_TASK,
    newCoordinatorPlan,
    newWorkerStep,
    observeWorker,
    openWorkerCount,
    pullRequestNumberOf,
    workerBranch,
    workerNotice,
    workerOf,
    workerPrompt,
    workerSummary,
    workerTitle,
    type WorkerNotice
} from '@shared/coordinator';
import { MAX_PLAN_STEPS, newPlanId, type Plan, type PlanStep, type StepPullRequest } from '@shared/plans';
import type { Project } from '@shared/projects';
import { agentForRepo, repoDisplayName, type AgentDefinition, type AppSettings } from '@shared/settings';
import { activeCount, type QueueState } from '@shared/task-queue';
import type { TerminalSession } from '@shared/terminal';
import { agentBudgetBlock, budgetWaitText, type ProviderUsage } from '@shared/usage';
import { ToolError, type McpWorkers, type ReportInput, type ToolCaller, type WorkerInput } from '../mcp/tools';

/** The timer checks the open workers at this interval. */
export const WORKER_TICK_MS = 30_000;

/** A checked start of a worker. `launch` starts it. */
export interface PreparedWorker {
    id: string;
    caller: ToolCaller;
    projectId: string;
    repoPath: string;
    repoName: string;
    branch: string;
    baseRef?: string;
    agent: AgentDefinition;
    model?: string;
    title: string;
    task: string;
    depth: number;
    maxDepth: number;
    /** The text of the approval dialog. */
    summary: string;
}

/** The page starts the worker: a new worktree and a new agent tab. The prompt can still be on its way. */
export interface WorkerStart {
    repoPath: string;
    branch: string;
    baseRef?: string;
    agentId: string;
    model?: string;
    prompt: string;
}

/** The parts of ShipWarden that the coordinator runs use. The main process gives the real ones. The tests give fakes. */
export interface CoordinatorSources {
    plans: {
        list(): Promise<Plan[]>;
        change(id: string, change: (plan: Plan | undefined) => Plan | undefined): Promise<Plan | undefined>;
    };
    settings(): Promise<AppSettings>;
    projects(): Promise<Project[]>;
    /** The plan usage for the usage budget. Called only when Settings › Agents has a budget. */
    usage(): Promise<readonly ProviderUsage[]>;
    queue(): Promise<QueueState>;
    sessions(): Promise<TerminalSession[]>;
    /** The main worktree of the repository of a worktree. */
    repoOf(worktree: string): Promise<string | undefined>;
    /** Makes the worktree and starts the agent in the page. */
    start(start: WorkerStart, signal: AbortSignal): Promise<{ worktreePath: string; sessionId: string; branch?: string }>;
    /** Types a message into the agent session of a coordinator. */
    send(target: { repoPath: string; worktree: string; sessionId: string }, message: string): Promise<void>;
    /** The open or newest pull request of the branch of a worktree, or undefined. */
    pullRequest(worktree: string): Promise<StepPullRequest | undefined>;
    /** Tells the page about a saved plan, so it can patch its cache. */
    onPlanChanged(plan: Plan): void;
    now?(): number;
}

interface Waiter {
    coordinator: string;
    workerId?: string;
    resolve(step: PlanStep): void;
}

/**
 * The coordinator runs in the main process: the MCP tools start_worker, list_workers, wait_for_worker, and
 * report_result, and a timer that watches the workers. It tells the coordinator when a worker finishes, stops, or waits
 * for 10 minutes. The page does not change a coordinator run. It shows it in the Plans view.
 */
export class Coordinators implements McpWorkers {
    private readonly waiters = new Set<Waiter>();
    private timer: ReturnType<typeof setInterval> | undefined;
    private ticking: Promise<void> | undefined;

    constructor(private readonly sources: CoordinatorSources) {}

    private now(): number {
        return this.sources.now?.() ?? Date.now();
    }

    /** Starts the timer. */
    start(): void {
        this.timer ??= setInterval(() => void this.tick(), WORKER_TICK_MS);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    /** A terminal session exited. When it is a worker, the coordinator gets the notice now, not at the next tick. */
    sessionExited(sessionId: string): void {
        void this.sources.plans.list().then(plans => {
            if (coordinatorPlans(plans).some(plan => plan.steps.some(step => step.sessionId === sessionId && isWorkerOpen(step)))) void this.tick();
        });
    }

    /* -------------------------------------------------------------------------------------------------------------- */
    /* start_worker                                                                                                    */
    /* -------------------------------------------------------------------------------------------------------------- */

    async prepare(caller: ToolCaller, input: WorkerInput): Promise<PreparedWorker> {
        const task = input.task.trim();
        if (task.length > MAX_WORKER_TASK) throw new ToolError(`The task is too long. The limit is ${MAX_WORKER_TASK} characters.`);
        const [settings, plans, projects] = await Promise.all([this.sources.settings(), this.sources.plans.list(), this.sources.projects()]);
        const callerDepth = depthOf(plans, caller.worktree);
        const tooDeep = depthError(callerDepth, settings.workerMaxDepth);
        if (tooDeep) throw new ToolError(tooDeep);

        const callerRepo = await this.sources.repoOf(caller.worktree);
        const repoPath = input.repository ? findRepo(settings, projects, input.repository) : callerRepo;
        if (!repoPath) {
            throw new ToolError(
                input.repository
                    ? `No repository of a ShipWarden project has the path or name "${input.repository}".`
                    : 'This worktree is not in a ShipWarden project. Give the "repository" argument.'
            );
        }
        const existing = coordinatorPlanOf(plans, caller.worktree);
        const projectId = existing?.projectId ?? projects.find(project => project.repos.includes(callerRepo ?? repoPath))?.id;
        if (!projectId) throw new ToolError('The repository is not in a ShipWarden project.');
        if ((existing?.steps.length ?? 0) >= MAX_PLAN_STEPS)
            throw new ToolError(`This agent has ${MAX_PLAN_STEPS} workers. That is the limit of one coordinator run.`);

        const agent = input.agent ? findAgent(settings, input.agent) : agentForRepo(settings, repoPath);
        if (!agent)
            throw new ToolError(
                `No agent in Settings › Agents has the ID or name "${input.agent}". The agents are: ${settings.agents.map(item => `"${item.name}"`).join(', ')}.`
            );
        if (input.model && !(canSetModel(agentProgramOf(agent.command)) && !commandSetsModel(agent.command))) {
            throw new ToolError(`ShipWarden cannot set the model of ${agent.name}. Remove the "model" argument.`);
        }

        const now = this.now();
        if (settings.usageBudget.percent !== null) {
            const block = agentBudgetBlock(await this.sources.usage(), settings.usageBudget, [agent.command], now);
            if (block) throw new ToolError(`${budgetWaitText(block, now)} Wait for the reset, or do the work in this worktree.`);
        }
        const queue = await this.sources.queue();
        const used = activeCount(queue) + openWorkerCount(plans);
        if (used >= queue.settings.maxRunning) {
            throw new ToolError(
                `${used} agents of the queue and of coordinator runs are working now, and the limit is ${queue.settings.maxRunning} (Settings › Queue › Agents at the same time). Wait for a worker with wait_for_worker, then try again.`
            );
        }

        const id = newPlanId();
        const title = input.title?.trim() || workerTitle(task);
        const branch = input.branch?.trim() || workerBranch(title, id);
        const repoName = repoDisplayName(settings, repoPath);
        return {
            id,
            caller,
            projectId,
            repoPath,
            repoName,
            branch,
            ...(input.base ? { baseRef: input.base } : {}),
            agent,
            ...(input.model ? { model: input.model } : {}),
            title,
            task,
            depth: callerDepth + 1,
            maxDepth: settings.workerMaxDepth,
            summary: `Start ${agent.name} in a new worktree of ${repoName} on the branch ${branch}: ${title}`
        };
    }

    async launch(prepared: PreparedWorker, signal: AbortSignal): Promise<Record<string, unknown>> {
        const { caller } = prepared;
        const started = await this.sources.start(
            {
                repoPath: prepared.repoPath,
                branch: prepared.branch,
                ...(prepared.baseRef ? { baseRef: prepared.baseRef } : {}),
                agentId: prepared.agent.id,
                ...(prepared.model ? { model: prepared.model } : {}),
                prompt: workerPrompt({ task: prepared.task, coordinator: basename(caller.worktree), depth: prepared.depth, maxDepth: prepared.maxDepth })
            },
            signal
        );
        const now = this.now();
        const step = newWorkerStep({
            id: prepared.id,
            title: prepared.title,
            task: prepared.task,
            repo: prepared.repoPath,
            branch: started.branch ?? prepared.branch,
            ...(prepared.baseRef ? { baseBranch: prepared.baseRef } : {}),
            worktreePath: started.worktreePath,
            sessionId: started.sessionId,
            depth: prepared.depth,
            now
        });
        const plans = await this.sources.plans.list();
        const existing = coordinatorPlanOf(plans, caller.worktree);
        const planId = existing?.id ?? newPlanId();
        const saved = await this.sources.plans.change(planId, current => {
            const plan =
                current ??
                newCoordinatorPlan({
                    projectId: prepared.projectId,
                    worktree: caller.worktree,
                    name: basename(caller.worktree),
                    depth: prepared.depth - 1,
                    now
                });
            const coordinator = {
                ...plan.coordinator,
                worktree: caller.worktree,
                depth: prepared.depth - 1,
                ...(caller.sessionId ? { sessionId: caller.sessionId } : {})
            };
            return { ...plan, id: planId, coordinator, status: 'running', steps: [...plan.steps, step], updatedAt: now };
        });
        if (saved) this.sources.onPlanChanged(saved);
        return {
            ...workerSummary(step),
            note: 'The worker is starting. ShipWarden sends you a message when it finishes, stops, or waits for 10 minutes. Call wait_for_worker to wait for it, or list_workers to see all workers.'
        };
    }

    /* -------------------------------------------------------------------------------------------------------------- */
    /* list_workers and wait_for_worker                                                                                */
    /* -------------------------------------------------------------------------------------------------------------- */

    async list(caller: string): Promise<Record<string, unknown>> {
        const plan = coordinatorPlanOf(await this.sources.plans.list(), caller);
        if (!plan) return { workers: [] };
        const sessions = await this.sources.sessions().catch(() => [] as TerminalSession[]);
        return {
            workers: plan.steps.map(step =>
                workerSummary(
                    step,
                    sessions.find(session => session.id === step.sessionId)
                )
            )
        };
    }

    async wait(caller: string, workerId: string | undefined, timeoutMs: number, signal: AbortSignal): Promise<Record<string, unknown>> {
        const plan = coordinatorPlanOf(await this.sources.plans.list(), caller);
        if (!plan) throw new ToolError('This agent has no workers. Call start_worker first.');
        if (workerId && !plan.steps.some(step => step.id === workerId)) {
            throw new ToolError(`This agent has no worker with the worker_id "${workerId}". Call list_workers to get the IDs.`);
        }
        const ready = this.readyStep(plan, workerId);
        if (ready) return this.answerWait(caller, ready);
        if (!workerId && !plan.steps.some(isWorkerOpen)) {
            return { done: true, note: 'All workers finished. Call list_workers to see their results.' };
        }
        const step = await new Promise<PlanStep | undefined>(resolve => {
            const waiter: Waiter = { coordinator: caller, ...(workerId ? { workerId } : {}), resolve: found => finish(found) };
            const timer = setTimeout(() => finish(undefined), timeoutMs);
            const onAbort = () => finish(undefined);
            const finish = (found: PlanStep | undefined) => {
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                this.waiters.delete(waiter);
                resolve(found);
            };
            signal.addEventListener('abort', onAbort, { once: true });
            this.waiters.add(waiter);
        });
        if (step) return this.answerWait(caller, step);
        if (signal.aborted) throw new ToolError('The tool call was cancelled.');
        const list = await this.list(caller);
        return { timedOut: true, ...list, note: 'No worker finished in the time. Call wait_for_worker again to wait more.' };
    }

    /**
     * The step that a wait can return at once: the given worker when it finished or has a new notice, else any worker
     * with a new notice. A worker that needs attention and was told about already makes the wait continue.
     */
    private readyStep(plan: Plan, workerId: string | undefined): PlanStep | undefined {
        if (workerId) {
            const step = plan.steps.find(item => item.id === workerId);
            return step && (!isWorkerOpen(step) || workerNotice(step)) ? step : undefined;
        }
        return plan.steps.find(step => workerNotice(step));
    }

    /** The answer of wait_for_worker. The coordinator gets the notice of the worker in the answer, so no message goes out for it. */
    private async answerWait(caller: string, step: PlanStep): Promise<Record<string, unknown>> {
        const notice = workerNotice(step);
        if (notice) await this.markNoticed(caller, step.id, notice);
        const plan = coordinatorPlanOf(await this.sources.plans.list(), caller);
        const open = plan?.steps.filter(isWorkerOpen).length ?? 0;
        return { worker: workerSummary(step), openWorkers: open };
    }

    /* -------------------------------------------------------------------------------------------------------------- */
    /* report_result                                                                                                   */
    /* -------------------------------------------------------------------------------------------------------------- */

    async report(caller: string, input: ReportInput): Promise<Record<string, unknown>> {
        const found = workerOf(await this.sources.plans.list(), caller);
        if (!found) throw new ToolError('This agent is not a worker. Only an agent that start_worker started can call report_result.');
        const pr = (await this.sources.pullRequest(caller).catch(() => undefined)) ?? urlPullRequest(input.pullRequestUrl, found.step);
        const now = this.now();
        const saved = await this.changeStep(found.plan.id, found.step.id, step => applyReport(step, { summary: input.summary, failed: input.failed }, now, pr));
        await this.deliver(saved ? [saved] : []);
        return {
            reported: true,
            status: input.failed ? 'failed' : 'done',
            ...(pr ? { pullRequest: pr.url } : {}),
            note: 'ShipWarden sent the result to the coordinator. You can stop now.'
        };
    }

    /* -------------------------------------------------------------------------------------------------------------- */
    /* The timer                                                                                                       */
    /* -------------------------------------------------------------------------------------------------------------- */

    /** Checks the open workers, saves the changes, and sends the notices. One check runs at a time. */
    tick(): Promise<void> {
        this.ticking ??= this.check().finally(() => {
            this.ticking = undefined;
        });
        return this.ticking;
    }

    private async check(): Promise<void> {
        const plans = coordinatorPlans(await this.sources.plans.list());
        const watched = plans.filter(plan => plan.steps.some(step => isWorkerOpen(step) || workerNotice(step)));
        if (watched.length === 0) return;
        const sessions = await this.sources.sessions();
        const now = this.now();
        const changed: Plan[] = [];
        for (const plan of watched) {
            let current: Plan | undefined = plan;
            for (const step of plan.steps) {
                const observation = observeWorker(
                    step,
                    sessions.find(session => session.id === step.sessionId),
                    now
                );
                if (!observation) continue;
                const pr =
                    observation.kind === 'stopped' && step.worktreePath ? await this.sources.pullRequest(step.worktreePath).catch(() => undefined) : undefined;
                current = (await this.changeStep(plan.id, step.id, item => applyObservation(item, observation, now, pr))) ?? current;
            }
            if (current) changed.push(current);
        }
        await this.deliver(changed, sessions);
    }

    /** Sends the new notices of the plans: to a waiting wait_for_worker call, else to the session of the coordinator. */
    private async deliver(plans: readonly Plan[], known?: TerminalSession[]): Promise<void> {
        let sessions = known;
        for (const plan of plans) {
            const coordinator = plan.coordinator;
            if (!coordinator) continue;
            for (const step of plan.steps) {
                const notice = workerNotice(step);
                if (!notice) continue;
                const waiter = [...this.waiters].find(item => item.coordinator === coordinator.worktree && (!item.workerId || item.workerId === step.id));
                if (waiter) {
                    // The answer of the wait marks the notice.
                    waiter.resolve(step);
                    continue;
                }
                if (!coordinator.sessionId) continue;
                sessions ??= await this.sources.sessions().catch(() => []);
                const session = sessions.find(item => item.id === coordinator.sessionId);
                // The coordinator stopped. Its notices wait until a new session calls list_workers or wait_for_worker.
                if (!session || session.exited) continue;
                const repoPath = await this.sources.repoOf(coordinator.worktree);
                if (!repoPath) continue;
                try {
                    await this.sources.send({ repoPath, worktree: coordinator.worktree, sessionId: coordinator.sessionId }, notice.message);
                    await this.markNoticed(coordinator.worktree, step.id, notice);
                } catch (error) {
                    // The window is closed, or the agent is asking a question. The next tick tries again.
                    console.warn(`[workers] A notice did not go to the coordinator: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
    }

    private async markNoticed(coordinator: string, stepId: string, notice: WorkerNotice): Promise<void> {
        const plan = coordinatorPlanOf(await this.sources.plans.list(), coordinator);
        if (plan) await this.changeStep(plan.id, stepId, step => ({ ...step, noticeKey: notice.key }));
    }

    /** Changes one step of a coordinator run and the status of the run. Returns the saved plan. */
    private async changeStep(planId: string, stepId: string, change: (step: PlanStep) => PlanStep): Promise<Plan | undefined> {
        const now = this.now();
        const saved = await this.sources.plans.change(planId, plan => {
            if (!plan?.steps.some(step => step.id === stepId)) return undefined;
            const steps = plan.steps.map(step => (step.id === stepId ? change(step) : step));
            const open = steps.some(isWorkerOpen);
            return {
                ...plan,
                steps,
                status: open ? 'running' : 'done',
                ...(open ? {} : { finishedAt: plan.finishedAt ?? now }),
                updatedAt: now
            };
        });
        if (saved) this.sources.onPlanChanged(saved);
        return saved;
    }
}

/** Finds a repository of the projects by its path, its name in Settings, or its folder name. */
export function findRepo(settings: AppSettings, projects: readonly Project[], wanted: string): string | undefined {
    const repos = [...new Set(projects.flatMap(project => project.repos))];
    const text = wanted.trim().replace(/\/+$/, '');
    const lower = text.toLowerCase();
    return (
        repos.find(repo => repo === text) ??
        repos.find(repo => repoDisplayName(settings, repo).toLowerCase() === lower) ??
        repos.find(repo => basename(repo).toLowerCase() === lower)
    );
}

/** Finds an agent of Settings › Agents by its ID or its name. The name ignores case. */
export function findAgent(settings: AppSettings, wanted: string): AgentDefinition | undefined {
    const lower = wanted.trim().toLowerCase();
    return settings.agents.find(agent => agent.id === wanted.trim()) ?? settings.agents.find(agent => agent.name.toLowerCase() === lower);
}

/** The pull request of an address from report_result, when the code host did not give one. */
function urlPullRequest(url: string | undefined, step: PlanStep): StepPullRequest | undefined {
    const number = url ? pullRequestNumberOf(url) : undefined;
    return url && number ? { number, url, base: step.baseBranch ?? 'default' } : undefined;
}
