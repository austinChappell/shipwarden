import type { AgentUpdate } from '@shared/agents';
import type { BranchSummary } from '@shared/github';
import {
    alwaysStart,
    finishReason,
    markFinished,
    markStarted,
    markStartFailed,
    markStarting,
    nextStarts,
    recoverQueue,
    START_GRACE_MS,
    type AgentObservation,
    type QueueItem,
    type StartCheck
} from '@shared/task-queue';
import { taskPrompt, type Task } from '@shared/tasks';
import type { TerminalSession } from '@shared/terminal';
import type { Worktree } from '@shared/worktrees';
import { agentStateStore } from '../terminal/agent-state-store';
import { outputActivity } from '../terminal/output-activity';
import { errorText } from '../util';
import { cachedQueue, changeQueue, queueQuery } from './queue-queries';
import { queryClient } from '../query-client';

/** An agent without hooks is busy while its terminal printed output in this time. The automations use the same time. */
const QUIET_MS = 10_000;

/** The functions of the app that the runner uses. They do not show dialogs or banners. They throw an error with a message. */
export interface QueueRunnerActions {
    /** The start of "Start in worktree" without the dialog: the branch template, the worktree, the link, and the agent. */
    startTaskQuietly(
        task: Task,
        connectionId: string,
        pluginId: string,
        repoPath: string,
        prompt: (branch: string) => string,
        agentId?: string
    ): Promise<{ worktree: Worktree; session: TerminalSession }>;
}

/** The newest state of the app. App gives it to the runner at each render. */
export interface QueueRunnerContext {
    /** False until the settings loaded. The runner does nothing before. */
    ready: boolean;
    sessions: TerminalSession[];
    /** The open pull requests by repository and head branch. */
    summaries: Record<string, Record<string, BranchSummary>>;
    actions: QueueRunnerActions;
}

/**
 * Runs the task queue while the app is open. The scheduler is in `@shared/task-queue`. This class gives it what the
 * app sees, starts the items that it selects, and saves each change.
 *
 * Each round does 2 steps:
 * 1. A running item whose agent finished (see `finishReason`) becomes "done". Its place is free.
 * 2. The next queued items start, up to the limit. Each start uses the start code of "Start in worktree".
 */
export class QueueRunner {
    private context: QueueRunnerContext | undefined;
    private started = false;
    /** The time of the first ready state. */
    private startedAt = 0;
    private ticking = false;
    /** True when a new round must follow the round that runs now. */
    private again = false;
    private soon: ReturnType<typeof setTimeout> | undefined;

    /**
     * The check before each start. It returns why the queue must wait, or undefined. A usage budget check goes here.
     * Each item that a check stops stays queued, and the next round checks again.
     */
    canStart: StartCheck = alwaysStart;

    /** Gives the runner the newest state of the app. The first ready state recovers the queue that the app read. */
    setContext(context: QueueRunnerContext): void {
        this.context = context;
        if (context.ready && !this.started) {
            this.started = true;
            this.startedAt = Date.now();
            void this.recover();
        }
    }

    private get ready(): QueueRunnerContext | undefined {
        return this.context?.ready && this.started ? this.context : undefined;
    }

    /** A start that did not end when the app stopped goes back to the queue. Then the first round runs. */
    private async recover(): Promise<void> {
        try {
            await changeQueue(state => recoverQueue(state, Date.now()));
        } catch (error) {
            console.warn(`[queue] The queue did not load: ${errorText(error)}`);
        }
        await this.tick();
    }

    /** A new agent state. An agent of the queue that stops its work can free a place. */
    onAgentState(sessionId: string, update: AgentUpdate): void {
        if (!this.ready || update.state === 'working') return;
        if (!cachedQueue().items.some(item => item.status === 'running' && item.sessionId === sessionId)) return;
        clearTimeout(this.soon);
        // Wait a moment: the agent can start a new turn at once, for example after a queued message.
        this.soon = setTimeout(() => void this.tick(), 2000);
    }

    /** Runs one round. A call during a round runs one more round after it. */
    async tick(): Promise<void> {
        if (!this.ready) return;
        if (this.ticking) {
            this.again = true;
            return;
        }
        this.ticking = true;
        try {
            do {
                this.again = false;
                const context = this.ready;
                if (!context) return;
                await this.finishItems(context);
                await this.startItems(context);
            } while (this.again);
        } catch (error) {
            console.warn(`[queue] A round of the queue failed: ${errorText(error)}`);
        } finally {
            this.ticking = false;
        }
    }

    private async finishItems(context: QueueRunnerContext): Promise<void> {
        const now = Date.now();
        // Just after the start of the app, the session list can still miss the agents that kept working. Do not count
        // them as exited yet.
        const settling = now - this.startedAt < START_GRACE_MS;
        await changeQueue(state => {
            let next = state;
            for (const item of state.items) {
                if (item.status !== 'running') continue;
                const seen = this.observe(context, item, now);
                if (settling && !seen.alive) continue;
                const reason = finishReason(item, seen, state.settings, now);
                if (reason) next = markFinished(next, item.id, reason, now);
            }
            return next;
        });
    }

    private async startItems(context: QueueRunnerContext): Promise<void> {
        await queryClient.ensureQueryData(queueQuery);
        const plan = nextStarts(cachedQueue(), Date.now(), this.canStart);
        // The starts run one after the other. Two git worktree commands at the same time can fail on the same repository.
        for (const item of plan.items) {
            await changeQueue(state => markStarting(state, item.id, Date.now()));
            await this.start(context, item);
        }
    }

    private async start(context: QueueRunnerContext, item: QueueItem): Promise<void> {
        try {
            const { worktree, session } = await context.actions.startTaskQuietly(
                item.task,
                item.connectionId,
                item.pluginId,
                item.repoPath,
                branch => taskPrompt(item.task, branch),
                item.agentId
            );
            await changeQueue(state =>
                markStarted(
                    state,
                    item.id,
                    { worktreePath: worktree.path, ...(worktree.branch ? { branch: worktree.branch } : {}), sessionId: session.id },
                    Date.now()
                )
            );
        } catch (error) {
            console.warn(`[queue] ${item.task.key ?? item.task.title} did not start: ${errorText(error)}`);
            await changeQueue(state => markStartFailed(state, item.id, errorText(error), Date.now()));
        }
    }

    /**
     * What the app sees of the agent of a running item. The session of the start comes first. When the user started a
     * new agent in the worktree, the newest agent of the worktree counts.
     */
    private observe(context: QueueRunnerContext, item: QueueItem, now: number): AgentObservation {
        const live = (session: TerminalSession) => session.isAgent && !session.exited;
        const session =
            context.sessions.find(entry => entry.id === item.sessionId && live(entry)) ??
            context.sessions.findLast(entry => !!item.worktreePath && entry.worktreePath === item.worktreePath && live(entry));
        const hasPullRequest = !!item.branch && !!context.summaries[item.repoPath]?.[item.branch];
        if (!session) return { alive: false, busy: false, hasPullRequest };
        const update = agentStateStore.getSnapshot().get(session.id);
        const state = update?.state ?? session.agentState;
        const lastOutput = outputActivity.get(session.id) ?? session.lastActiveAt;
        if (state) {
            const busy = state === 'working' || state === 'starting' || state === 'waiting';
            return { alive: true, busy, ...(busy ? {} : { quietSince: update?.at ?? lastOutput }), hasPullRequest };
        }
        // An agent without hooks: the time of its last output tells if it works.
        const busy = lastOutput !== undefined && now - lastOutput < QUIET_MS;
        return { alive: true, busy, ...(busy || lastOutput === undefined ? {} : { quietSince: lastOutput }), hasPullRequest };
    }
}

/** The one runner of the app. */
export const queueRunner = new QueueRunner();
