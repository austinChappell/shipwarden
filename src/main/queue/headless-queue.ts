import type { BranchSummary } from '@shared/github';
import {
    finishReason,
    markFinished,
    markStarted,
    markStartFailed,
    markStarting,
    nextStarts,
    observeQueueAgent,
    recoverQueue,
    START_GRACE_MS,
    type QueueItem,
    type QueueState
} from '@shared/task-queue';
import type { TerminalSession } from '@shared/terminal';

/** The part of the queue store that the runner uses. `QueueStore` has this shape. */
export interface HeadlessQueueStore {
    get(): Promise<QueueState>;
    save(state: QueueState): Promise<QueueState>;
}

export interface HeadlessQueueOptions {
    store: HeadlessQueueStore;
    sessions(): Promise<TerminalSession[]>;
    /** The newest branch summaries by repository. The "pull request" mode finishes an item with a pull request. */
    summaries(): Record<string, Record<string, BranchSummary>>;
    /** Makes the worktree of the task and starts its agent. Throws an error with a message. */
    startTask(item: QueueItem): Promise<{ worktree: { path: string; branch?: string }; session: TerminalSession }>;
    now?: () => number;
    log?: (message: string) => void;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the task queue in the background helper while ShipWarden is closed. It uses the scheduler of
 * `@shared/task-queue`, the same as the runner of the page. Each round reads the queue file, finishes the items whose
 * agent finished, and starts the next items up to the limit. The usage budget of Settings › Agents needs the usage
 * data of the app, so the helper does not check it.
 */
export class HeadlessQueue {
    private readonly options: HeadlessQueueOptions;
    private readonly now: () => number;
    private startedAt = 0;
    private started = false;
    private round: Promise<void> | undefined;

    constructor(options: HeadlessQueueOptions) {
        this.options = options;
        this.now = options.now ?? Date.now;
    }

    /** True when the queue has running items in the "pull request" mode. The poller then loads their summaries. */
    async reposToWatch(): Promise<string[]> {
        const state = await this.options.store.get();
        if (state.settings.finishWhen !== 'pullRequest') return [];
        return [...new Set(state.items.filter(item => item.status === 'running').map(item => item.repoPath))];
    }

    /** A start that did not end when the last owner stopped goes back to the queue. */
    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;
        this.startedAt = this.now();
        await this.change(state => recoverQueue(state, this.now()));
    }

    /** Stops the rounds. Waits for the round that runs now, so a start does not stay "starting". */
    async stop(): Promise<void> {
        this.started = false;
        await this.round;
    }

    /** Runs one round. A call during a round waits for that round. */
    tick(): Promise<void> {
        if (!this.started) return Promise.resolve();
        this.round ??= this.runRound().finally(() => {
            this.round = undefined;
        });
        return this.round;
    }

    private async runRound(): Promise<void> {
        try {
            await this.finishItems();
            await this.startItems();
        } catch (error) {
            this.options.log?.(`A round of the queue failed: ${errorText(error)}`);
        }
    }

    private async change(change: (state: QueueState) => QueueState): Promise<QueueState> {
        const before = await this.options.store.get();
        const next = change(before);
        return next === before ? before : this.options.store.save(next);
    }

    private async finishItems(): Promise<void> {
        const now = this.now();
        const sessions = await this.options.sessions();
        const summaries = this.options.summaries();
        // Just after the start, the session list can still miss the agents that kept working. Do not count them as exited yet.
        const settling = now - this.startedAt < START_GRACE_MS;
        await this.change(state => {
            let next = state;
            for (const item of state.items) {
                if (item.status !== 'running') continue;
                const seen = observeQueueAgent(item, sessions, summaries, now, session => ({
                    state: session.agentState,
                    at: session.agentStateAt,
                    lastOutput: session.lastActiveAt
                }));
                if (settling && !seen.alive) continue;
                const reason = finishReason(item, seen, state.settings, now);
                if (reason) next = markFinished(next, item.id, reason, now);
            }
            return next;
        });
    }

    private async startItems(): Promise<void> {
        const plan = nextStarts(await this.options.store.get(), this.now());
        // The starts run one after the other. Two git worktree commands at the same time can fail on the same repository.
        for (const item of plan.items) {
            if (!this.started) return;
            await this.change(state => markStarting(state, item.id, this.now()));
            try {
                const { worktree, session } = await this.options.startTask(item);
                await this.change(state =>
                    markStarted(
                        state,
                        item.id,
                        { worktreePath: worktree.path, ...(worktree.branch ? { branch: worktree.branch } : {}), sessionId: session.id },
                        this.now()
                    )
                );
            } catch (error) {
                this.options.log?.(`${item.task.key ?? item.task.title} did not start: ${errorText(error)}`);
                await this.change(state => markStartFailed(state, item.id, errorText(error), this.now()));
            }
        }
    }
}
