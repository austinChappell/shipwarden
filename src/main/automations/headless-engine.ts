import type { AgentMode } from '@shared/agent-modes';
import {
    appOnlyActions,
    checksVariable,
    clipDetail,
    decideRun,
    HEADLESS_TRIGGERS,
    HOLD_LIMIT_MS,
    runHttpAction,
    scheduleEvent,
    StopRun,
    WAIT_FOR_APP_PREFIX,
    waitForAppDetail,
    type AutomationHttpRequest
} from '@shared/automation-engine';
import { ciFailedEvents, type WorktreePlace } from '@shared/automation-events';
import { conditionHolds, describeCondition, renderTemplate, type HttpResponse } from '@shared/automation-templates';
import {
    automationMatches,
    branchName,
    dueScheduleSlot,
    eventVariables,
    flattenActions,
    tokenLimitReached,
    usesVariable,
    type Automation,
    type AutomationAction,
    type AutomationEvent,
    type AutomationRun,
    type AutomationRunState,
    type AutomationSettings
} from '@shared/automations';
import type { BranchSummary, CheckRun } from '@shared/github';
import type { TerminalSession } from '@shared/terminal';
import { BUDGET_WAIT_PREFIX } from '@shared/usage';
import type { Worktree } from '@shared/worktrees';
import type { RunChange } from './automation-store';

/** An agent without hooks is busy while its terminal printed output in this time. The page uses the same time. */
export const QUIET_MS = 10_000;

/** The part of the automation store that the engine uses. `AutomationStore` has this shape. */
export interface HeadlessStore {
    list(): Promise<{ automations: Automation[] }>;
    runState(): Promise<AutomationRunState>;
    claim(run: AutomationRun): Promise<AutomationRun | null>;
    updateRun(id: string, change: RunChange): Promise<AutomationRun | undefined>;
    setScheduleRun(automationId: string, at: number): Promise<void>;
}

/** The agent functions of the helper. They use the PTY host. They throw an error with a message for the run history. */
export interface HeadlessAgents {
    sessions(): Promise<TerminalSession[]>;
    /** Makes a worktree on a new branch and gives the prompt to a new agent in it. */
    startInNewWorktree(
        repoPath: string,
        branch: string,
        prompt: string,
        agentId?: string,
        mode?: AgentMode
    ): Promise<{ worktree: Pick<Worktree, 'path' | 'branch'>; session: TerminalSession }>;
    /** Sends a prompt to the agent session, else to the agent of the worktree, else to a new agent in the worktree. */
    promptAgent(
        worktreePath: string,
        prompt: string,
        target: { sessionId?: string; agentId?: string; repoPath?: string; mode?: AgentMode }
    ): Promise<TerminalSession>;
}

export interface HeadlessEngineOptions {
    store: HeadlessStore;
    settings(): Promise<AutomationSettings>;
    /** The worktrees of all projects. */
    places(): Promise<WorktreePlace[]>;
    agents: HeadlessAgents;
    http(request: AutomationHttpRequest): Promise<HttpResponse>;
    /** The checks of a commit, and the saved log of an Actions job. Without them, the {{checks}} variable needs the app. */
    checks?: { list(worktreePath: string, sha: string): Promise<CheckRun[]>; saveLog(worktreePath: string, jobId: number): Promise<string> };
    notify(title: string, body: string): void;
    /** A new run waits for the approval of the user. The helper sends a push notification. */
    onPending?(run: AutomationRun): void;
    now?: () => number;
    log?: (message: string) => void;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** True while the agent works, starts, or waits for an answer. An agent without hooks is busy while it prints output. */
export function sessionBusy(session: TerminalSession, now: number): boolean {
    const state = session.agentState;
    if (state && state !== 'exited') return state === 'working' || state === 'starting' || state === 'waiting';
    return now - (session.lastActiveAt ?? 0) < QUIET_MS;
}

/**
 * Runs the automations in the background helper while ShipWarden is closed. Only one process runs an engine at a
 * time (see `EngineLock`). It uses the same decisions as the engine of the page (`@shared/automation-engine`).
 *
 * - The triggers: schedules, and CI failures from the branch summaries that `onSummaries` gets.
 * - The actions: "Start an agent", "Send to the agent", "Show a notification", "HTTP request", "If", and "Stop".
 *   A run with another action waits for the app ("held"). The page runs it when ShipWarden opens.
 * - A run that waits for approval stays "pending". The phone or the app can approve it (`approve`).
 */
export class HeadlessEngine {
    private readonly options: HeadlessEngineOptions;
    private readonly now: () => number;
    private startedAt = 0;
    private started = false;
    private ticking = false;
    private automations: Automation[] = [];
    private previousSummaries: Record<string, Record<string, BranchSummary>> = {};
    /** The runs whose actions run now. */
    private readonly executing = new Map<string, Promise<void>>();

    constructor(options: HeadlessEngineOptions) {
        this.options = options;
        this.now = options.now ?? Date.now;
    }

    /** Starts the engine. A run that was "running" when its process stopped cannot continue, so it fails. */
    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;
        this.startedAt = this.now();
        this.previousSummaries = {};
        for (const run of (await this.options.store.runState()).runs.filter(item => item.status === 'running')) {
            await this.options.store.updateRun(run.id, { status: 'failed', detail: 'ShipWarden stopped during the run.' });
        }
    }

    /** Stops the engine. Waits for the actions that run now, so the next owner does not see a "running" run. */
    async stop(): Promise<void> {
        this.started = false;
        await Promise.allSettled([...this.executing.values()]);
    }

    /** The automations that can run in the helper for a trigger. */
    private active(trigger: Automation['trigger']['type']): Automation[] {
        return this.automations.filter(automation => automation.status !== 'off' && automation.trigger.type === trigger);
    }

    /** True when an automation watches the CI of pull requests. The poller then loads the branch summaries. */
    async watchesCi(): Promise<boolean> {
        await this.loadAutomations();
        return this.active('ci.failed').length > 0;
    }

    private async loadAutomations(): Promise<void> {
        this.automations = (await this.options.store.list()).automations.filter(automation => HEADLESS_TRIGGERS.has(automation.trigger.type));
    }

    /** The timer: schedules and held runs. The helper calls it every 30 seconds. */
    async tick(): Promise<void> {
        if (!this.started || this.ticking) return;
        this.ticking = true;
        try {
            await this.loadAutomations();
            await this.runSchedules();
            await this.retryHeld();
        } catch (error) {
            this.options.log?.(`An automation tick failed: ${errorText(error)}`);
        } finally {
            this.ticking = false;
        }
    }

    private async runSchedules(): Promise<void> {
        const now = new Date(this.now());
        for (const automation of this.active('schedule')) {
            const trigger = automation.trigger;
            if (trigger.type !== 'schedule') continue;
            const state = await this.options.store.runState();
            // A schedule time before the start of this engine does not run. The app ran it, or it was missed.
            const slot = dueScheduleSlot(trigger, now, state.scheduleRuns[automation.id], this.startedAt);
            if (!slot) continue;
            await this.options.store.setScheduleRun(automation.id, slot.getTime());
            await this.dispatch(scheduleEvent(automation, slot), [automation]);
        }
    }

    /** New branch summaries: CI failures. The first summaries of a repository give no events. */
    async onSummaries(summaries: Record<string, Record<string, BranchSummary>>): Promise<void> {
        const previous = this.previousSummaries;
        this.previousSummaries = { ...previous, ...summaries };
        if (!this.started) return;
        await this.loadAutomations();
        if (this.active('ci.failed').length === 0) return;
        const places = await this.options.places();
        const now = this.now();
        for (const [repo, after] of Object.entries(summaries)) {
            const before = previous[repo];
            if (!before || before === after) continue;
            for (const event of ciFailedEvents(repo, before, after, places, now)) await this.dispatch(event);
        }
    }

    /** Starts a run of each matching automation. `only` limits the automations, for an event of one automation. */
    private async dispatch(event: AutomationEvent, only?: Automation[]): Promise<void> {
        for (const automation of only ?? this.automations) {
            if (automationMatches(automation, event)) await this.fire(automation, event);
        }
    }

    private async fire(automation: Automation, event: AutomationEvent): Promise<void> {
        const { store } = this.options;
        const run = decideRun(automation, event, await store.runState(), { settings: await this.options.settings(), usage: [], now: this.now() });
        if (!run) return;
        const claimed = await store.claim(run);
        if (!claimed) return;
        if (claimed.status === 'pending') {
            this.options.notify(`${automation.name} is waiting for your approval`, event.label);
            this.options.onPending?.(claimed);
        } else if (claimed.status === 'running') {
            await this.execute(claimed);
        }
    }

    /** Runs a pending run that the user approved, for example on the phone. Returns false for a run that is not pending. */
    async approve(runId: string): Promise<boolean> {
        const run = (await this.options.store.runState()).runs.find(item => item.id === runId);
        if (run?.status !== 'pending') return false;
        const updated = await this.options.store.updateRun(run.id, { status: 'running', detail: '' });
        if (updated) void this.execute(updated);
        return true;
    }

    /** Stops a pending or held run. Its event does not run again. Returns false for a run in another state. */
    async skip(runId: string): Promise<boolean> {
        const run = (await this.options.store.runState()).runs.find(item => item.id === runId);
        if (run?.status !== 'pending' && run?.status !== 'held') return false;
        await this.options.store.updateRun(run.id, { status: 'skipped', detail: 'You skipped the run.' });
        return true;
    }

    /**
     * Tries the held runs again. A run that waits for the app stays held until the app runs it. A run that waits for the
     * usage budget stays held too: the helper has no usage data, so only the app can check the budget.
     */
    private async retryHeld(): Promise<void> {
        const held = (await this.options.store.runState()).runs.filter(
            item => item.status === 'held' && !item.detail?.startsWith(WAIT_FOR_APP_PREFIX) && !item.detail?.startsWith(BUDGET_WAIT_PREFIX)
        );
        for (const run of held) await this.execute(run);
    }

    /** Runs the actions of a run. A second call for the same run waits for the first one. */
    private execute(run: AutomationRun): Promise<void> {
        const running = this.executing.get(run.id);
        if (running) return running;
        const work = this.executeOnce(run).finally(() => this.executing.delete(run.id));
        this.executing.set(run.id, work);
        return work;
    }

    /** Returns the labels of what only the app can do for this run. Empty when the helper can run it. */
    private needsApp(automation: Automation): string[] {
        const labels = appOnlyActions(automation);
        // The task of the worktree needs the task managers. Only the app runs them.
        if (usesVariable(automation, 'task.')) labels.push('the task variables');
        if (usesVariable(automation, 'checks') && !this.options.checks) labels.push('the checks variable');
        return labels;
    }

    private async executeOnce(run: AutomationRun): Promise<void> {
        const { store } = this.options;
        const details: string[] = [];
        let automation: Automation | undefined;
        try {
            automation =
                this.automations.find(item => item.id === run.automationId) ?? (await store.list()).automations.find(item => item.id === run.automationId);
            if (!automation) {
                await store.updateRun(run.id, { status: 'failed', detail: 'The automation does not exist anymore.' });
                return;
            }
            if (automation.status === 'off' && run.event.manual !== true) {
                await store.updateRun(run.id, { status: 'skipped', detail: 'The automation is off.' });
                return;
            }
            const appOnly = this.needsApp(automation);
            if (appOnly.length > 0) {
                await store.updateRun(run.id, { status: 'held', detail: waitForAppDetail(appOnly) });
                return;
            }
            const settings = await this.options.settings();
            const state = await store.runState();
            // A held run waited. The tokens can be above a limit now.
            const overLimit =
                run.status === 'held' && run.event.manual !== true ? tokenLimitReached(state.runs, automation, settings.dailyTokens, this.now()) : undefined;
            if (overLimit) {
                await store.updateRun(run.id, { status: 'skipped', detail: overLimit });
                return;
            }
            const sessions = await this.options.agents.sessions();
            const hold = this.holdReason(automation, run, sessions, state);
            if (hold) {
                if (this.now() - run.createdAt > HOLD_LIMIT_MS) {
                    await this.fail(run, automation, 'The run waited for more than 12 hours.');
                } else if (run.status !== 'held' || run.detail !== hold) {
                    await store.updateRun(run.id, { status: 'held', detail: hold });
                }
                return;
            }
            if (run.status !== 'running') await store.updateRun(run.id, { status: 'running', detail: '' });
            const values = eventVariables(run.event, await this.checkVariables(automation, run.event));
            try {
                await this.runActions(automation, run, automation.actions, values, details);
            } catch (error) {
                if (!(error instanceof StopRun)) throw error;
                details.push(error.detail);
            }
            await store.updateRun(run.id, { status: 'done', detail: clipDetail(details.filter(Boolean).join('\n')) });
        } catch (error) {
            await this.fail(run, automation, [...details.filter(Boolean), errorText(error)].join('\n'));
        }
    }

    /** Returns why the run must wait now, or undefined. */
    private holdReason(automation: Automation, run: AutomationRun, sessions: TerminalSession[], state: AutomationRunState): string | undefined {
        const actions = flattenActions(automation.actions);
        const now = this.now();
        const live = sessions.filter(session => !session.exited);
        if (actions.some(action => action.type === 'sendToAgent')) {
            const session =
                (run.event.sessionId ? live.find(item => item.id === run.event.sessionId) : undefined) ??
                live.find(item => item.worktreePath === run.event.worktreePath && item.isAgent);
            if (session && sessionBusy(session, now)) return 'Waiting for the agent to finish its turn.';
        }
        if (actions.some(action => action.type === 'startAgent')) {
            const working = state.runs.filter(item => {
                if (item.automationId !== automation.id || item.id === run.id || !item.sessionId) return false;
                const session = live.find(entry => entry.id === item.sessionId);
                return !!session && sessionBusy(session, now);
            }).length;
            if (working >= automation.limits.maxRunning) {
                return `Waiting until fewer agents of this automation work. ${working} work now, and the limit is ${automation.limits.maxRunning}.`;
            }
        }
        return undefined;
    }

    private async checkVariables(automation: Automation, event: AutomationEvent): Promise<Record<string, string>> {
        const checks = this.options.checks;
        const canHaveChecks = event.trigger === 'ci.failed' || event.trigger === 'manual';
        if (!checks || !canHaveChecks || !usesVariable(automation, 'checks') || !event.worktreePath || !event.pr?.headSha) return {};
        const target = event.worktreePath;
        const list = await checks.list(target, event.pr.headSha);
        return { checks: await checksVariable(list, check => checks.saveLog(target, check.id).catch(() => undefined)) };
    }

    /** Runs a list of actions in order. An "If" action runs one of its lists. A "Stop" action throws `StopRun`. */
    private async runActions(
        automation: Automation,
        run: AutomationRun,
        actions: readonly AutomationAction[],
        values: Record<string, string | undefined>,
        details: string[]
    ): Promise<void> {
        for (const action of actions) {
            if (action.type === 'if') {
                const agrees = conditionHolds(action.condition, values);
                details.push(`If ${describeCondition(action.condition)}: ${agrees ? 'yes' : 'no'}.`);
                await this.runActions(automation, run, agrees ? action.then : (action.else ?? []), values, details);
                continue;
            }
            if (action.type === 'stop') {
                const reason = action.reason ? renderTemplate(action.reason, values) : undefined;
                if (action.fail) throw new Error(reason ?? 'A "Stop" action failed the run.');
                throw new StopRun(reason ?? 'A "Stop" action stopped the run.');
            }
            details.push(await this.runAction(automation, run, action, values));
        }
    }

    private async runAction(automation: Automation, run: AutomationRun, action: AutomationAction, values: Record<string, string | undefined>): Promise<string> {
        const { store, agents } = this.options;
        const event = run.event;
        switch (action.type) {
            case 'sendToAgent': {
                if (!event.worktreePath) throw new Error('The worktree does not exist anymore.');
                const session = await agents.promptAgent(event.worktreePath, renderTemplate(action.prompt, values), {
                    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
                    ...(event.repoPath ? { repoPath: event.repoPath } : {}),
                    ...(action.mode ? { mode: action.mode } : {})
                });
                await store.updateRun(run.id, {
                    sessionId: session.id,
                    worktreePath: event.worktreePath,
                    turn: { sessionId: session.id, from: this.now() - 2000 }
                });
                return `Sent the prompt to ${session.title} in ${event.branch ?? event.worktreePath}.`;
            }
            case 'startAgent': {
                const repoPath = event.repoPath ?? automation.binding.repos?.[0];
                if (!repoPath) throw new Error('The automation has no repository. Select one in the editor.');
                const template = action.branch ?? `automation/${automation.id}-{{date}}-{{time}}`;
                const branch = branchName(renderTemplate(template, { ...values, time: values.time?.replace(':', '') }));
                const started = await agents.startInNewWorktree(
                    repoPath,
                    branch,
                    renderTemplate(action.prompt, { ...values, branch }),
                    action.agentId,
                    action.mode
                );
                await store.updateRun(run.id, {
                    sessionId: started.session.id,
                    worktreePath: started.worktree.path,
                    turn: { sessionId: started.session.id, from: this.now() - 2000 }
                });
                return `Started ${started.session.title} in a new worktree on ${started.worktree.branch ?? started.worktree.path}.`;
            }
            case 'notify':
                this.options.notify(renderTemplate(action.title, values), action.body ? renderTemplate(action.body, values) : event.label);
                return 'Showed a notification.';
            case 'http':
                return runHttpAction(automation, action, values, request => this.options.http(request));
            default:
                // `needsApp` stops a run with another action before it starts.
                throw new Error(`The background helper cannot run the action "${action.type}".`);
        }
    }

    private async fail(run: AutomationRun, automation: Automation | undefined, detail: string): Promise<void> {
        await this.options.store.updateRun(run.id, { status: 'failed', detail: clipDetail(detail) });
        this.options.notify(`${automation?.name ?? run.automationName} failed`, clipDetail(detail).slice(0, 300));
    }
}
