import type { NotificationTarget } from '@shared/api';
import type { AgentMode } from '@shared/agent-modes';
import {
    ACTION_TYPES,
    automationMatches,
    branchName,
    dueScheduleSlot,
    eventVariables,
    firedKey,
    localDateTime,
    needsRepo,
    renderTemplate,
    runsForTarget,
    startOfDay,
    tokenLimitReached,
    taskMatchesTrigger,
    taskRepo,
    planUsageReached,
    type Automation,
    type AutomationAction,
    type AutomationEvent,
    type AutomationRun,
    type AutomationSettings,
    type RunStatus,
    type Trigger,
    type TriggerType
} from '@shared/automations';
import {
    agentDoneEvent,
    ciFailedEvents,
    closedPullRequests,
    commentEvents,
    conflictEvents,
    mergedEvent,
    pullRequestResolver,
    taskEvent,
    taskKey,
    type WorktreePlace
} from '@shared/automation-events';
import type { AgentUpdate } from '@shared/agents';
import type { BranchSummary, RepoRef } from '@shared/github';
import type { NotificationSettings } from '@shared/notifications';
import { linkMatchesTask, pickCollection, type StartStatusResult, type Task, type TaskLink, type TaskPerson, type TaskSource } from '@shared/tasks';
import type { TerminalSession } from '@shared/terminal';
import type { ProviderUsage } from '@shared/usage';
import type { Worktree } from '@shared/worktrees';
import { checkLine } from '../app/agent-text';
import { PEOPLE_STALE_MS } from '../components/tasks/use-assignee-filter';
import { loadTaskList } from '../components/tasks/use-task-list';
import { findFreshTask, taskQueryKeys, type CachedDetail } from '../components/tasks/task-view-logic';
import { collectionsQueryOptions } from '../components/tasks/use-task-source';
import type { DashboardNews } from '../dashboard-store';
import { ciKeys } from '../github/ci-queries';
import { branchStatusKey } from '../github/use-branch-status';
import { keyRoots, queryClient } from '../query-client';
import { agentStateStore } from '../terminal/agent-state-store';
import { outputActivity } from '../terminal/output-activity';
import { addRunToCache, automationRunsQuery, cachedRunState, patchRunState, replaceRunInCache } from './automation-queries';

const api = window.shipwarden;

/** A "Task matches" automation reads its collection at most one time in this interval. The Dashboard uses the same interval. */
export const TASK_POLL_MS = 5 * 60_000;
/** A run that waits for a busy agent fails after this time. */
const HOLD_LIMIT_MS = 12 * 3600_000;
/** An agent without hooks is busy while its terminal printed output in this time. */
const QUIET_MS = 10_000;
/** The run history shows at most this much of an answer or an error. */
const MAX_DETAIL = 4000;
/** The text of a run that a limit stopped. The engine records it one time for each target. */
const LIMIT_DETAIL = 'The automation reached its limit of runs for this target.';
/** A word in the text of a run that the token limit stopped. The engine records it one time each day. */
const TOKEN_LIMIT_MARK = 'tokens today';
/** The check conclusions that count as a failure. */
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'error', 'action_required']);

/** A worktree of any project, with its repository folder. */
export interface EnginePlace extends WorktreePlace {
    worktree: Worktree;
}

/** The functions of the app that run the actions. They do not show dialogs or banners. They throw an error with a message. */
export interface EngineActions {
    promptAgent(
        worktree: Pick<Worktree, 'path'>,
        prompt: string,
        target?: { sessionId?: string; agentId?: string; repoPath?: string; mode?: AgentMode }
    ): Promise<TerminalSession>;
    startTaskQuietly(
        task: Task,
        connectionId: string,
        pluginId: string,
        repoPath: string,
        prompt: (branch: string) => string,
        agentId?: string,
        mode?: AgentMode
    ): Promise<{ worktree: Worktree; session: TerminalSession }>;
    startInNewWorktree(
        repoPath: string,
        branch: string,
        prompt: string,
        agentId?: string,
        mode?: AgentMode
    ): Promise<{ worktree: Worktree; session: TerminalSession }>;
    removeWorktreeQuietly(repoPath: string, worktree: Worktree, deleteBranch: boolean): Promise<string>;
    moveTaskToStatus(task: Task, connectionId: string, status: string): Promise<StartStatusResult>;
}

/** The newest state of the app. App gives it to the engine at each render. */
export interface EngineContext {
    /** False until the automations, the runs and the settings loaded. The engine does nothing before. */
    ready: boolean;
    automations: Automation[];
    settings: AutomationSettings;
    notifications: NotificationSettings;
    usage: readonly ProviderUsage[];
    sessions: TerminalSession[];
    places: EnginePlace[];
    /** The open pull requests by repository and head branch. Only the repositories that the engine watches. */
    summaries: Record<string, Record<string, BranchSummary>>;
    links: Record<string, TaskLink>;
    actions: EngineActions;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function clip(text: string): string {
    return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

/** A file name for a note: the characters that a note name does not accept become spaces. */
function noteFileName(text: string): string {
    return (
        text
            .replace(/[/\\:*?"<>|]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim() || 'Automation'
    );
}

/**
 * Runs the automations while the app is open. It gets events from the data that the app loads already (the branch
 * summaries, the Dashboard refreshes and the agent hooks). It reads task collections and runs schedules on a timer.
 *
 * For each event and each automation that matches, it records a run in the main process. The main process refuses a
 * second run of the same event, also after a restart. Then the run waits for approval, waits for a busy agent, or
 * runs its actions.
 */
export class AutomationEngine {
    private context: EngineContext | undefined;
    private previousSummaries: Record<string, Record<string, BranchSummary>> = {};
    /** The start of the engine. A schedule time before it does not run. */
    private readonly startedAt = Date.now();
    /** When each automation became active (not "off"). A schedule time before it does not run. */
    private readonly activeSince = new Map<string, number>();
    /** The task automations that must record their current list again, because they were "off". */
    private readonly needsSeed = new Set<string>();
    private readonly lastTaskPoll = new Map<string, number>();
    /** The runs whose actions run now. */
    private readonly executing = new Set<string>();
    /** The worktrees of the manual runs, by path. `context.places` does not always contain them. */
    private readonly manualPlaces = new Map<string, EnginePlace>();
    private started = false;
    private ticking = false;
    private heldTimer: ReturnType<typeof setTimeout> | undefined;

    /** Gives the engine the newest state of the app. */
    setContext(context: EngineContext): void {
        this.context = context;
        const now = Date.now();
        for (const automation of context.automations) {
            const active = automation.status !== 'off';
            const known = this.activeSince.has(automation.id);
            if (active && !known) {
                this.activeSince.set(automation.id, now);
                // An automation that was off can have tasks that match now. They must not all start agents.
                if (this.started) this.needsSeed.add(automation.id);
            }
            if (!active && known) this.activeSince.delete(automation.id);
        }
        if (context.ready && !this.started) {
            this.started = true;
            void this.recover();
        }
    }

    private get ready(): EngineContext | undefined {
        return this.context?.ready && this.started ? this.context : undefined;
    }

    /** The automations that can run for a trigger. */
    private active(trigger: TriggerType): Automation[] {
        return (this.context?.automations ?? []).filter(automation => automation.status !== 'off' && automation.trigger.type === trigger);
    }

    /**
     * After a start: a run that was "running" when the app closed cannot continue, so it fails. Held and pending runs
     * stay, and the timer tries the held runs again.
     */
    private async recover(): Promise<void> {
        await queryClient.fetchQuery(automationRunsQuery);
        for (const run of cachedRunState().runs.filter(item => item.status === 'running')) {
            await this.update(run.id, { status: 'failed', detail: 'ShipWarden stopped during the run.' });
        }
    }

    /* -------------------------------------------------------------------------------------------------------------- */
    /* Events                                                                                                          */
    /* -------------------------------------------------------------------------------------------------------------- */

    /** New branch summaries: CI failures and merged pull requests. The first summaries of a repository give no events. */
    onSummaries(summaries: Record<string, Record<string, BranchSummary>>): void {
        const context = this.ready;
        const previous = this.previousSummaries;
        this.previousSummaries = { ...previous, ...summaries };
        if (!context) return;
        const now = Date.now();
        const ciRules = this.active('ci.failed');
        const mergeRules = this.active('pr.merged');
        for (const [repo, after] of Object.entries(summaries)) {
            const before = previous[repo];
            if (!before || before === after) continue;
            if (ciRules.length > 0) {
                for (const event of ciFailedEvents(repo, before, after, context.places, now)) this.dispatch(event);
            }
            if (mergeRules.length > 0) {
                for (const closed of closedPullRequests(repo, before, after, context.places)) {
                    void this.checkMerged(repo, closed.branch, closed.summary, closed.place as EnginePlace);
                }
            }
        }
    }

    /** A pull request left the open list. One request tells whether it is merged or closed. */
    private async checkMerged(repo: string, branch: string, summary: BranchSummary, place: EnginePlace): Promise<void> {
        try {
            const path = place.worktree.path;
            const status = await queryClient.fetchQuery({ queryKey: branchStatusKey(path), queryFn: () => api.github.status(path), staleTime: 0 });
            const pr = status?.pullRequest;
            if (pr && pr.number === summary.number && pr.state === 'MERGED') {
                this.dispatch(mergedEvent(repo, branch, summary, place, Date.now()));
            }
        } catch (error) {
            console.warn(`[automations] The state of pull request #${summary.number} did not load: ${errorText(error)}`);
        }
    }

    /** New Dashboard items: comments, reviews and merge conflicts on pull requests of worktree branches. */
    async onDashboardNews(news: DashboardNews): Promise<void> {
        const context = this.ready;
        if (!context) return;
        const wantComments = this.active('pr.comment').length > 0 && news.prComments.length > 0;
        const wantConflicts = this.active('pr.conflict').length > 0 && news.myPullRequests.length > 0;
        if (!wantComments && !wantConflicts) return;
        // The GitHub repository of each watched folder. The cache keeps it for the session.
        const remotes: Record<string, RepoRef | null> = {};
        await Promise.all(
            Object.keys(context.summaries).map(async repo => {
                remotes[repo] = await queryClient
                    .fetchQuery({ queryKey: [...keyRoots.repoOf, repo], queryFn: () => api.github.repoOf(repo), staleTime: Number.POSITIVE_INFINITY })
                    .catch(() => null);
            })
        );
        const resolve = pullRequestResolver(remotes, context.summaries, context.places);
        const now = Date.now();
        if (wantComments) commentEvents(news.prComments, resolve, now).forEach(event => this.dispatch(event));
        if (wantConflicts) conflictEvents(news.myPullRequests, resolve, now).forEach(event => this.dispatch(event));
    }

    /** A new agent state. "done" can start an "agent.done" run. A ready agent can take a held run. */
    onAgentState(sessionId: string, update: AgentUpdate): void {
        const context = this.ready;
        if (!context) return;
        if (update.state === 'done' && this.active('agent.done').length > 0) {
            const session = context.sessions.find(item => item.id === sessionId);
            const event = session && agentDoneEvent(session, update, context.places, context.summaries);
            if (event) this.dispatch(event);
        }
        if (update.state === 'done' || update.state === 'exited') {
            void this.endTurns(sessionId, update.at);
        }
        if (update.state === 'done' || update.state === 'idle') {
            // Wait a moment: the agent can start a new turn at once, for example after a queued message.
            clearTimeout(this.heldTimer);
            this.heldTimer = setTimeout(() => void this.retryHeld(), 2000);
        }
    }

    /** The timer: schedules, task collections and held runs. App calls it every 30 seconds. */
    async tick(): Promise<void> {
        const context = this.ready;
        if (!context || this.ticking) return;
        this.ticking = true;
        try {
            await this.runSchedules();
            await this.pollTasks(context);
            await this.retryHeld();
            await this.countOpenTurns(context);
        } finally {
            this.ticking = false;
        }
    }

    private async runSchedules(): Promise<void> {
        const now = new Date();
        for (const automation of this.active('schedule')) {
            const trigger = automation.trigger;
            if (trigger.type !== 'schedule') continue;
            const notBefore = Math.max(this.startedAt, this.activeSince.get(automation.id) ?? this.startedAt);
            const slot = dueScheduleSlot(trigger, now, cachedRunState().scheduleRuns[automation.id], notBefore);
            if (!slot) continue;
            const at = slot.getTime();
            await api.automations.setScheduleRun(automation.id, at);
            patchRunState(state => ({ ...state, scheduleRuns: { ...state.scheduleRuns, [automation.id]: at } }));
            const { time } = localDateTime(slot);
            const repoPath = automation.binding.repos?.[0];
            this.dispatch(
                {
                    trigger: 'schedule',
                    key: `schedule:${automation.id}:${slot.toISOString()}`,
                    target: `schedule:${automation.id}`,
                    label: `${localDateTime(slot).date} ${time}`,
                    at,
                    time,
                    ...(repoPath ? { repoPath, worktreePath: repoPath } : {})
                },
                [automation]
            );
        }
    }

    /** Reads the collections of each "Task matches" automation, at most one time in TASK_POLL_MS. */
    private async pollTasks(context: EngineContext): Promise<void> {
        const now = Date.now();
        for (const automation of this.active('task.new')) {
            const trigger = automation.trigger;
            const { connectionId, collections } = automation.binding;
            if (trigger.type !== 'task.new' || !connectionId || !collections?.length) continue;
            if (now - (this.lastTaskPoll.get(automation.id) ?? 0) < TASK_POLL_MS) continue;
            this.lastTaskPoll.set(automation.id, now);
            const reseed = this.needsSeed.has(automation.id);
            // A task can be in two collections, for example a ClickUp task in two lists. It starts one run only.
            const dispatched = new Set<string>();
            let failed = false;
            for (const [index, collection] of collections.entries()) {
                try {
                    await this.pollCollection(context, automation, trigger, connectionId, collection.id, index === 0, reseed, dispatched, now);
                } catch (error) {
                    failed = true;
                    console.warn(`[automations] "${automation.name}" did not read the tasks of ${collection.name ?? collection.id}: ${errorText(error)}`);
                }
            }
            // A collection that failed must record its list on the next poll, so keep the flag.
            if (!failed) this.needsSeed.delete(automation.id);
        }
    }

    /** Reads one collection of a "Task matches" automation and starts a run for each new task that matches. */
    private async pollCollection(
        context: EngineContext,
        automation: Automation,
        trigger: Extract<Trigger, { type: 'task.new' }>,
        connectionId: string,
        collectionId: string,
        first: boolean,
        reseed: boolean,
        dispatched: Set<string>,
        now: number
    ): Promise<void> {
        const request = <T>(method: string, params: unknown) => api.tasks.request(connectionId, method, params) as Promise<T>;
        const { source, tasks } = await loadCollectionTasks(connectionId, collectionId);
        let me: string | undefined;
        if (trigger.assignedToMe && source.capabilities.assignees) {
            const people = await queryClient.fetchQuery({
                queryKey: taskQueryKeys.people(connectionId, collectionId),
                queryFn: () => request<{ people: TaskPerson[]; me?: string }>('people/list', { collection: collectionId }),
                staleTime: PEOPLE_STALE_MS
            });
            me = people.me;
        }
        const links = Object.values(context.links);
        const matches = tasks.filter(task => taskMatchesTrigger(trigger, task, me) && !links.some(link => linkMatchesTask(link, connectionId, task)));
        const state = cachedRunState();
        const scope = `${automation.id}|${collectionId}`;
        // An older version recorded one entry for the automation. That entry is for its first collection.
        const seeded = state.seeded.includes(scope) || (first && state.seeded.includes(automation.id));
        if (!seeded || reseed) {
            // The first list: these tasks were there before the automation. Only later tasks start runs.
            const keys = matches.map(task => taskKey(connectionId, task.id));
            await api.automations.seed(automation.id, keys, scope);
            patchRunState(current => ({
                ...current,
                seeded: [...new Set([...current.seeded, scope])],
                fired: { ...current.fired, ...Object.fromEntries(keys.map(key => [firedKey(automation.id, { key }), now])) }
            }));
            return;
        }
        const needs = needsRepo(automation);
        for (const task of matches) {
            const repoPath = taskRepo(automation.binding, task);
            // A task without a repository waits. It runs when it gets a label with a repository.
            if (needs && !repoPath) continue;
            const event = taskEvent(task, connectionId, source.pluginId, repoPath, now);
            if (dispatched.has(event.key) || state.fired[firedKey(automation.id, event)] !== undefined) continue;
            dispatched.add(event.key);
            this.dispatch(event, [automation]);
        }
    }

    /* -------------------------------------------------------------------------------------------------------------- */
    /* Runs                                                                                                            */
    /* -------------------------------------------------------------------------------------------------------------- */

    /** Starts a run of each matching automation. `only` limits the automations, for an event of one automation. */
    private dispatch(event: AutomationEvent, only?: Automation[]): void {
        for (const automation of only ?? this.context?.automations ?? []) {
            if (automationMatches(automation, event)) void this.fire(automation, event);
        }
    }

    private async fire(automation: Automation, event: AutomationEvent): Promise<void> {
        const context = this.ready;
        if (!context || context.settings.paused) return;
        const state = cachedRunState();
        if (state.fired[firedKey(automation.id, event)] !== undefined) return;
        const now = Date.now();
        const run = (status: RunStatus, detail?: string): AutomationRun => ({
            id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            automationId: automation.id,
            automationName: automation.name,
            status,
            event,
            createdAt: now,
            updatedAt: now,
            ...(detail ? { detail } : {}),
            ...(event.worktreePath ? { worktreePath: event.worktreePath } : {}),
            ...(event.sessionId ? { sessionId: event.sessionId } : {})
        });
        if (automation.status === 'dry-run') {
            await this.claim(run('dry-run', `A dry run. The automation would: ${describeActions(automation.actions)}.`));
            return;
        }
        const used = runsForTarget(state.runs, automation.id, event.target);
        if (used >= automation.limits.maxRunsPerTarget) {
            // Record the stop one time for each target, so the history shows why the automation does nothing.
            const stopped = state.runs.some(item => item.automationId === automation.id && item.event.target === event.target && item.detail === LIMIT_DETAIL);
            if (!stopped) await this.claim(run('skipped', LIMIT_DETAIL));
            return;
        }
        const overUsage = planUsageReached(context.usage, automation, context.settings.pauseAtUsage);
        if (overUsage) {
            await this.claim(run('skipped', overUsage));
            return;
        }
        const overTokens = tokenLimitReached(state.runs, automation, context.settings.dailyTokens, now);
        if (overTokens) {
            // Record the stop one time each day, so the history shows why the automation does nothing.
            const today = startOfDay(now);
            const stopped = state.runs.some(
                item => item.automationId === automation.id && item.status === 'skipped' && item.createdAt >= today && item.detail?.includes(TOKEN_LIMIT_MARK)
            );
            if (!stopped) await this.claim(run('skipped', overTokens));
            return;
        }
        if (automation.limits.approval === 'ask') {
            const claimed = await this.claim(run('pending', 'Waits for your approval.'));
            if (claimed) {
                this.notify(`${automation.name} waits for your approval`, event.label, { view: 'automations' });
            }
            return;
        }
        const claimed = await this.claim(run('running'));
        if (claimed) await this.execute(claimed);
    }

    private async claim(run: AutomationRun): Promise<AutomationRun | null> {
        const claimed = await api.automations.claim(run);
        if (claimed) addRunToCache(claimed);
        return claimed;
    }

    private async update(id: string, change: Parameters<typeof api.automations.updateRun>[1]): Promise<AutomationRun | undefined> {
        const updated = await api.automations.updateRun(id, change);
        if (updated) replaceRunInCache(updated);
        return updated;
    }

    /**
     * Starts a manual run of an automation for an event that `manual*Event` made. The run ignores the trigger, the
     * status "off", the approval, the pause and the limits. A dry-run automation records a dry run only.
     * `place` is the worktree of the event. The engine does not know the worktrees of other projects while no
     * automation is on.
     */
    async runNow(automationId: string, event: AutomationEvent, place?: EnginePlace): Promise<void> {
        const context = this.ready;
        if (!context) throw new Error('The automations did not load yet. Try again in a few seconds.');
        const automation = context.automations.find(item => item.id === automationId);
        if (!automation) throw new Error('The automation does not exist anymore.');
        if (place) this.manualPlaces.set(place.worktree.path, place);
        const now = Date.now();
        const dryRun = automation.status === 'dry-run';
        const claimed = await this.claim({
            id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            automationId: automation.id,
            automationName: automation.name,
            status: dryRun ? 'dry-run' : 'running',
            event: { ...event, manual: true },
            createdAt: now,
            updatedAt: now,
            ...(dryRun ? { detail: `A dry run. The automation would: ${describeActions(automation.actions)}.` } : {}),
            ...(event.worktreePath ? { worktreePath: event.worktreePath } : {})
        });
        if (!claimed) throw new Error('The run did not start. Try again.');
        // Do not wait for the actions. They can take minutes. The run history shows the result and the errors.
        if (!dryRun) void this.execute(claimed);
    }

    /** Runs a pending run that the user approved. */
    async approve(runId: string): Promise<void> {
        const run = cachedRunState().runs.find(item => item.id === runId);
        if (run?.status !== 'pending') return;
        const updated = await this.update(run.id, { status: 'running', detail: '' });
        if (updated) await this.execute(updated);
    }

    /** Stops a pending or held run. Its event does not run again. */
    async skip(runId: string): Promise<void> {
        const run = cachedRunState().runs.find(item => item.id === runId);
        if (run?.status !== 'pending' && run?.status !== 'held') return;
        await this.update(run.id, { status: 'skipped', detail: 'You skipped the run.' });
    }

    /** Tries the held runs again. A run whose agent is ready now runs. */
    private async retryHeld(): Promise<void> {
        for (const run of cachedRunState().runs.filter(item => item.status === 'held')) {
            await this.execute(run);
        }
    }

    /** Returns why the run must wait now, or undefined. */
    private holdReason(context: EngineContext, automation: Automation, run: AutomationRun): string | undefined {
        if (automation.actions.some(action => action.type === 'sendToAgent')) {
            const session = this.agentOf(context, run.event);
            if (session && agentBusy(session)) return 'Waits until the agent finishes its turn.';
        }
        if (automation.actions.some(action => action.type === 'startAgent')) {
            const working = cachedRunState().runs.filter(item => {
                if (item.automationId !== automation.id || item.id === run.id || !item.sessionId) return false;
                const session = context.sessions.find(entry => entry.id === item.sessionId && !entry.exited);
                return !!session && agentBusy(session);
            }).length;
            if (working >= automation.limits.maxRunning) {
                return `Waits until fewer agents of this automation work. ${working} work now, and the limit is ${automation.limits.maxRunning}.`;
            }
        }
        return undefined;
    }

    /** The agent session for a run: the session of an "agent.done" event, else the agent of the worktree. */
    private agentOf(context: EngineContext, event: AutomationEvent): TerminalSession | undefined {
        if (event.sessionId) {
            const session = context.sessions.find(item => item.id === event.sessionId && !item.exited);
            if (session) return session;
        }
        return context.sessions.find(item => item.worktreePath === event.worktreePath && item.isAgent && !item.exited);
    }

    /** Runs the actions of a run in order. A held run that must still wait stays held. */
    private async execute(run: AutomationRun): Promise<void> {
        const context = this.ready;
        if (!context || this.executing.has(run.id)) return;
        this.executing.add(run.id);
        try {
            const automation = context.automations.find(item => item.id === run.automationId);
            if (!automation) {
                await this.update(run.id, { status: 'failed', detail: 'The automation does not exist anymore.' });
                return;
            }
            const manual = run.event.manual === true;
            if (automation.status === 'off' && !manual) {
                await this.update(run.id, { status: 'skipped', detail: 'The automation is off.' });
                return;
            }
            // A held run waited. The usage or the tokens can be above a limit now.
            const overLimit =
                run.status === 'held' && !manual
                    ? (planUsageReached(context.usage, automation, context.settings.pauseAtUsage) ??
                      tokenLimitReached(cachedRunState().runs, automation, context.settings.dailyTokens, Date.now()))
                    : undefined;
            if (overLimit) {
                await this.update(run.id, { status: 'skipped', detail: overLimit });
                return;
            }
            const hold = this.holdReason(context, automation, run);
            if (hold) {
                if (Date.now() - run.createdAt > HOLD_LIMIT_MS) {
                    await this.fail(run, automation, 'The run waited for more than 12 hours.');
                } else if (run.status !== 'held' || run.detail !== hold) {
                    await this.update(run.id, { status: 'held', detail: hold });
                }
                return;
            }
            if (run.status !== 'running') await this.update(run.id, { status: 'running', detail: '' });
            // Load the task lists before the actions, so a task lookup reads the cache and the Tasks view has the same data.
            if (looksUpTask(automation, run.event)) await this.hydrateTaskLists(context, automation, run.event);
            const values = eventVariables(run.event, await this.extraVariables(automation, run.event));
            const details: string[] = [];
            for (const action of automation.actions) {
                details.push(await this.runAction(context, automation, run, action, values));
            }
            await this.update(run.id, { status: 'done', detail: clip(details.filter(Boolean).join('\n')) });
        } catch (error) {
            const automation = context.automations.find(item => item.id === run.automationId);
            await this.fail(run, automation, errorText(error));
        } finally {
            this.executing.delete(run.id);
        }
    }

    /** Ends the open turns of a session: the agent finished the turn that a run started, or it exited. Then counts their tokens. */
    private async endTurns(sessionId: string, at: number): Promise<void> {
        for (const run of cachedRunState().runs) {
            const turn = run.turn;
            if (turn?.sessionId !== sessionId || turn.to !== undefined || at < turn.from) continue;
            const updated = await this.update(run.id, { turn: { ...turn, to: at } });
            if (updated) await this.countTurn(updated);
        }
    }

    /** Counts the tokens of the turns that did not end, and of the ended turns without a last count. */
    private async countOpenTurns(context: EngineContext): Promise<void> {
        const since = Date.now() - 2 * 24 * 3600_000;
        for (const run of cachedRunState().runs) {
            const turn = run.turn;
            if (!turn || turn.counted || run.createdAt < since) continue;
            // A closed tab ends the turn. Its transcript stays, so the last count still works.
            if (turn.to === undefined && !context.sessions.some(item => item.id === turn.sessionId && !item.exited)) {
                const updated = await this.update(run.id, { turn: { ...turn, to: Date.now() } });
                if (updated) await this.countTurn(updated);
                continue;
            }
            await this.countTurn(run);
        }
    }

    /**
     * Counts the tokens of the turn of a run in the transcript of its session. Only Claude Code sessions have a transcript.
     * A count after the end of the turn is the last one.
     */
    private async countTurn(run: AutomationRun): Promise<void> {
        const turn = run.turn;
        if (!turn) return;
        const transcript =
            agentStateStore.getSnapshot().get(turn.sessionId)?.transcript ?? this.context?.sessions.find(item => item.id === turn.sessionId)?.agentTranscript;
        const done = turn.to !== undefined;
        if (!transcript) {
            if (done) await this.update(run.id, { turn: { ...turn, counted: true } });
            return;
        }
        try {
            const { tokens, cacheReads } = await api.automations.countTokens(transcript, turn.from, turn.to);
            if (tokens !== run.tokens || cacheReads !== run.cacheReads || done) {
                await this.update(run.id, { tokens, cacheReads, ...(done ? { turn: { ...turn, counted: true } } : {}) });
            }
        } catch (error) {
            console.warn(`[automations] The tokens of a run were not counted: ${errorText(error)}`);
            if (done) await this.update(run.id, { turn: { ...turn, counted: true } });
        }
    }

    private async fail(run: AutomationRun, automation: Automation | undefined, detail: string): Promise<void> {
        await this.update(run.id, { status: 'failed', detail: clip(detail) });
        this.notify(`${automation?.name ?? run.automationName} failed`, detail, { view: 'automations' });
    }

    /** The variables that need a request. Only "ci.failed" has one: the failed checks, with the paths of their saved logs. */
    private async extraVariables(automation: Automation, event: AutomationEvent): Promise<Record<string, string>> {
        const usesChecks = automation.actions.some(action => 'prompt' in action && action.prompt.includes('{{checks'));
        if (event.trigger !== 'ci.failed' || !usesChecks || !event.worktreePath || !event.pr?.headSha) return {};
        const target = event.worktreePath;
        const sha = event.pr.headSha;
        const checks = await queryClient.fetchQuery({ queryKey: ciKeys.checks(target, sha), queryFn: () => api.github.checks(target, sha), staleTime: 0 });
        const failed = checks.filter(check => FAILED_CONCLUSIONS.has(check.conclusion ?? ''));
        const lines = await Promise.all(
            failed.map(async check => checkLine(check, check.isActions ? await api.github.saveJobLog(target, check.id).catch(() => undefined) : undefined))
        );
        return { checks: lines.length > 0 ? lines.join('\n') : '(ShipWarden found no failed checks. Look at the checks of the pull request.)' };
    }

    private async runAction(
        context: EngineContext,
        automation: Automation,
        run: AutomationRun,
        action: AutomationAction,
        values: Record<string, string | undefined>
    ): Promise<string> {
        const event = run.event;
        const place = event.worktreePath
            ? (context.places.find(item => item.worktree.path === event.worktreePath) ?? this.manualPlaces.get(event.worktreePath))
            : undefined;
        switch (action.type) {
            case 'sendToAgent': {
                if (!place) throw new Error('The worktree does not exist anymore.');
                const session = await context.actions.promptAgent(place.worktree, renderTemplate(action.prompt, values), {
                    ...(event.trigger === 'agent.done' && event.sessionId ? { sessionId: event.sessionId } : {}),
                    repoPath: place.repo,
                    ...(action.mode ? { mode: action.mode } : {})
                });
                await this.update(run.id, { sessionId: session.id, worktreePath: place.worktree.path, turn: { sessionId: session.id, from: turnStart() } });
                return `Sent the prompt to ${session.title} in ${place.worktree.branch ?? place.worktree.path}.`;
            }
            case 'startAgent': {
                const repoPath = event.repoPath ?? automation.binding.repos?.[0];
                if (!repoPath) throw new Error('The automation has no repository. Select one in the editor.');
                const started =
                    event.trigger === 'task.new' && event.task && event.connectionId && event.pluginId
                        ? await context.actions.startTaskQuietly(
                              event.task,
                              event.connectionId,
                              event.pluginId,
                              repoPath,
                              branch => renderTemplate(action.prompt, { ...values, branch }),
                              action.agentId,
                              action.mode
                          )
                        : await this.startScheduled(context, automation, action, repoPath, values);
                await this.update(run.id, {
                    sessionId: started.session.id,
                    worktreePath: started.worktree.path,
                    turn: { sessionId: started.session.id, from: turnStart() }
                });
                return `Started ${started.session.title} in a new worktree on ${started.worktree.branch ?? started.worktree.path}.`;
            }
            case 'runHeadless': {
                const folder = event.worktreePath ?? event.repoPath ?? automation.binding.repos?.[0];
                if (!folder) throw new Error('The automation has no repository. Select one in the editor.');
                const result = await api.ask.run({
                    id: `automation-${run.id}`,
                    worktree: folder,
                    prompt: renderTemplate(action.prompt, values),
                    withTokens: true
                });
                if (result.tokens !== undefined) {
                    const before = cachedRunState().runs.find(item => item.id === run.id);
                    await this.update(run.id, {
                        tokens: (before?.tokens ?? 0) + result.tokens,
                        cacheReads: (before?.cacheReads ?? 0) + (result.cacheReads ?? 0)
                    });
                }
                if (!action.saveNote) return clip(`${result.agent} answered:\n${result.answer}`);
                const { date, time } = localDateTime(new Date());
                const name = `Automations/${noteFileName(automation.name)} ${date} ${time.replace(':', '')}.md`;
                const note = await api.notes.create(name, `# ${automation.name}\n\n_${date} ${time} · ${result.agent}_\n\n${result.answer}\n`);
                await this.update(run.id, { noteName: note.name });
                return `Saved the answer of ${result.agent} in the note "${note.name}".`;
            }
            case 'moveTask':
                return this.moveTask(context, event, action.status);
            case 'removeWorktree': {
                if (!place || !event.repoPath) throw new Error('The worktree does not exist anymore.');
                const busy = context.sessions.find(item => item.worktreePath === place.worktree.path && item.isAgent && !item.exited && agentBusy(item));
                if (busy) throw new Error('An agent works in the worktree. ShipWarden did not remove it.');
                return context.actions.removeWorktreeQuietly(event.repoPath, place.worktree, action.deleteBranch === true);
            }
            case 'notify': {
                const target: NotificationTarget =
                    event.worktreePath && place ? { view: 'worktree', worktreePath: event.worktreePath } : { view: 'automations' };
                this.notify(renderTemplate(action.title, values), action.body ? renderTemplate(action.body, values) : event.label, target, true);
                return 'Showed a notification.';
            }
        }
    }

    /** Makes a worktree for a scheduled run. The branch name comes from the action, with the variables. */
    private async startScheduled(
        context: EngineContext,
        automation: Automation,
        action: Extract<AutomationAction, { type: 'startAgent' }>,
        repoPath: string,
        values: Record<string, string | undefined>
    ) {
        const template = action.branch ?? `automation/${automation.id}-{{date}}-{{time}}`;
        const branch = branchName(renderTemplate(template, { ...values, time: values.time?.replace(':', '') }));
        return context.actions.startInNewWorktree(repoPath, branch, renderTemplate(action.prompt, { ...values, branch }), action.agentId, action.mode);
    }

    /**
     * Loads the task lists of the connection of the worktree task into the cache: the collections of the automation and
     * the collection of the Tasks view. A list that loaded in the last TASK_POLL_MS does not load again.
     * A failure does not stop the run. The task lookup then asks the task manager for the task.
     */
    private async hydrateTaskLists(context: EngineContext, automation: Automation, event: AutomationEvent): Promise<void> {
        const link = event.worktreePath ? context.links[event.worktreePath] : undefined;
        if (!link) return;
        const connectionId = link.connectionId ?? link.pluginId;
        try {
            const ids = new Set(automation.binding.connectionId === connectionId ? (automation.binding.collections ?? []).map(item => item.id) : []);
            const source = await queryClient.fetchQuery<TaskSource>({
                queryKey: taskQueryKeys.source(connectionId),
                queryFn: () => api.tasks.source(connectionId)
            });
            const collections = await queryClient.fetchQuery(collectionsQueryOptions(connectionId));
            const shown = pickCollection(collections.list, collections.saved, source.capabilities.defaultCollectionOnly);
            if (shown) ids.add(shown);
            await Promise.all([...ids].map(id => loadCollectionTasks(connectionId, id)));
        } catch (error) {
            console.warn(`[automations] "${automation.name}" did not load the task lists: ${errorText(error)}`);
        }
    }

    /** Moves the task of the event, or the task of the worktree. A worktree without a task is not an error. */
    private async moveTask(context: EngineContext, event: AutomationEvent, status: string): Promise<string> {
        let task = event.task;
        let connectionId = event.connectionId;
        if (!task) {
            const link = event.worktreePath ? context.links[event.worktreePath] : undefined;
            if (!link) return 'The worktree has no task, so no task moved.';
            const linkConnection = link.connectionId ?? link.pluginId;
            connectionId = linkConnection;
            task = cachedTask(linkConnection, link.taskId) ?? ((await api.tasks.request(linkConnection, 'tasks/get', { id: link.taskId })) as Task);
        }
        if (!connectionId) return 'The task has no task manager, so it did not move.';
        const name = task.key ?? task.title;
        const result = await context.actions.moveTaskToStatus(task, connectionId, status);
        switch (result) {
            case 'moved':
                return `Moved ${name} to "${status}".`;
            case 'already':
                return `${name} has the status "${status}" already.`;
            case 'missing':
                throw new Error(`The task manager has no status "${status}" for ${name}.`);
            case 'unsupported':
                throw new Error('The task manager cannot change the status of tasks.');
            case 'none':
                return 'No status to move to.';
        }
    }

    /**
     * Shows a notification when Settings › Notifications allows the "Automations" event. A "notify" action (`always`)
     * needs only the main switch of the notifications.
     */
    private notify(title: string, body: string | undefined, target: NotificationTarget, always = false): void {
        const settings = this.context?.notifications;
        if (!settings?.enabled) return;
        const event = settings.events.automation;
        if (!always && !event.enabled) return;
        if (!always && !settings.whenFocused && document.hasFocus()) return;
        api.notifications.show({ title, body: body ? clip(body).slice(0, 300) : undefined, sound: event.sound, target });
    }
}

/**
 * Reads the task source and the tasks of one collection, with the default filter. The Tasks view uses the same keys,
 * so the view shows the new list and sends no request. A list that is newer than TASK_POLL_MS does not load again.
 */
export async function loadCollectionTasks(connectionId: string, collectionId: string): Promise<{ source: TaskSource; tasks: Task[] }> {
    const request = <T>(method: string, params: unknown) => api.tasks.request(connectionId, method, params) as Promise<T>;
    const source = await queryClient.fetchQuery<TaskSource>({
        queryKey: taskQueryKeys.source(connectionId),
        queryFn: () => api.tasks.source(connectionId)
    });
    const filter = source.filters.find(item => item.default)?.id ?? source.filters[0]?.id;
    const tasks = await queryClient.fetchQuery({
        queryKey: taskQueryKeys.list(connectionId, collectionId, filter),
        queryFn: () => loadTaskList(request, collectionId, filter),
        staleTime: TASK_POLL_MS
    });
    return { source, tasks };
}

/** True when an action must find a task that the event does not contain: the task of the worktree. */
function looksUpTask(automation: Automation, event: AutomationEvent): boolean {
    return !event.task && automation.actions.some(action => action.type === 'moveTask');
}

/**
 * The task from the cache: from a list of the connection, or from the details of the task, if they loaded in the last
 * TASK_POLL_MS. Undefined when the cache has no fresh copy.
 */
function cachedTask(connectionId: string, taskId: string): Task | undefined {
    const cache = queryClient.getQueryCache();
    const lists = cache.findAll({ queryKey: [...keyRoots.tasks, 'list', connectionId] }).map(query => ({
        tasks: query.state.data as Task[] | undefined,
        updatedAt: query.state.dataUpdatedAt,
        invalidated: query.state.isInvalidated
    }));
    const detail = cache.find<CachedDetail>({ queryKey: taskQueryKeys.detail(connectionId, taskId), exact: true });
    if (detail?.state.data) {
        lists.push({ tasks: [detail.state.data.task], updatedAt: detail.state.dataUpdatedAt, invalidated: detail.state.isInvalidated });
    }
    return findFreshTask(lists, taskId, Date.now(), TASK_POLL_MS);
}

/** The start of the turn of a prompt that ShipWarden just sent. A small margin covers the clocks of the agent and the app. */
function turnStart(): number {
    return Date.now() - 2000;
}

/** True while the agent works, starts or waits for an answer. An agent without hooks is busy while it prints output. */
function agentBusy(session: TerminalSession): boolean {
    const state = agentStateStore.getSnapshot().get(session.id)?.state;
    if (state) return state === 'working' || state === 'starting' || state === 'waiting';
    const last = outputActivity.get(session.id);
    return last !== undefined && Date.now() - last < QUIET_MS;
}

/** A short text of the actions, for a dry run. */
export function describeActions(actions: readonly AutomationAction[]): string {
    return actions.map(action => ACTION_TYPES.find(item => item.type === action.type)?.label.toLowerCase() ?? action.type).join(', then ');
}

export const automationEngine = new AutomationEngine();
