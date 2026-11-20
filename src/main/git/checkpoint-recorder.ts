import type { AgentUpdate } from '@shared/agents';
import type { CheckpointKind } from '@shared/checkpoints';
import type { TerminalSession } from '@shared/terminal';
import type { CheckpointInput } from './checkpoints';

/** An agent without a turn hook is idle when its terminal has no output for this time. */
export const IDLE_OUTPUT_MS = 15_000;

/** The app reads the session data again after this time, because a shell tab can start or stop an agent. */
const SESSION_CACHE_MS = 10_000;

export interface CheckpointRecorderOptions {
    /** The terminal session with an ID. Undefined when the session is not known. */
    session(id: string): Promise<TerminalSession | undefined>;
    /** Saves a checkpoint of the worktree of a folder. */
    create(cwd: string, input: CheckpointInput): Promise<unknown>;
    /** Called after each saved or skipped checkpoint, with the folder. */
    onSaved?(cwd: string): void;
    idleMs?: number;
}

interface SessionKind {
    /** True for an agent that does not report its turns through hooks. */
    noHooks: boolean;
    at: number;
}

/**
 * Saves the checkpoints of the agent turns:
 * - An agent with hooks gets a checkpoint when it gets a new prompt (the `UserPromptSubmit` hook).
 * - An agent without a turn hook (for example Codex) gets a checkpoint when its output stops for 15 seconds.
 * Each method returns at once and never throws, because a checkpoint must not delay the hook or the terminal.
 * The checkpoints of one folder run one after the other.
 */
export class CheckpointRecorder {
    /** The last work of each folder, so the checkpoints of one folder do not run at the same time. */
    private readonly chains = new Map<string, Promise<void>>();
    /** The sessions that reported a hook state. They get checkpoints from their prompts, not from their output. */
    private readonly hooked = new Set<string>();
    private readonly kinds = new Map<string, SessionKind>();
    private readonly pendingKinds = new Set<string>();
    private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private readonly options: CheckpointRecorderOptions) {}

    /** Receives a state change of an agent from its hooks. A new prompt saves a checkpoint. */
    agentState(id: string, update: AgentUpdate): void {
        if (update.state === 'exited') return;
        this.hooked.add(id);
        this.clearIdle(id);
        if (update.newTurn) this.save(id, 'prompt', update.prompt);
    }

    /** Receives the output of a terminal. For an agent without a turn hook, it starts the idle timer again. */
    output(id: string): void {
        if (this.hooked.has(id)) return;
        const kind = this.kinds.get(id);
        const now = Date.now();
        if (!kind || now - kind.at > SESSION_CACHE_MS) {
            this.refreshKind(id);
        }
        if (!kind?.noHooks) return;
        this.clearIdle(id);
        this.idleTimers.set(
            id,
            setTimeout(() => {
                this.idleTimers.delete(id);
                this.save(id, 'idle');
            }, this.options.idleMs ?? IDLE_OUTPUT_MS)
        );
    }

    /** Forgets a session that closed. */
    forget(id: string): void {
        this.clearIdle(id);
        this.hooked.delete(id);
        this.kinds.delete(id);
    }

    /** Stops all timers. */
    stop(): void {
        for (const id of [...this.idleTimers.keys()]) this.clearIdle(id);
    }

    private clearIdle(id: string): void {
        clearTimeout(this.idleTimers.get(id));
        this.idleTimers.delete(id);
    }

    private refreshKind(id: string): void {
        if (this.pendingKinds.has(id)) return;
        this.pendingKinds.add(id);
        void this.options
            .session(id)
            .catch(() => undefined)
            .then(session => {
                // An agent tab or a shell tab with an agent program, but no hook state, has no turn hook.
                const noHooks = !!session && !session.exited && (session.isAgent || !!session.agentProgram) && !session.agentState;
                this.kinds.set(id, { noHooks, at: Date.now() });
            })
            .finally(() => this.pendingKinds.delete(id));
    }

    private save(id: string, kind: CheckpointKind, prompt?: string): void {
        void this.options
            .session(id)
            .catch(() => undefined)
            .then(session => {
                if (!session) return;
                const cwd = session.worktreePath ?? session.cwd;
                const previous = this.chains.get(cwd) ?? Promise.resolve();
                const next = previous
                    .then(() => this.options.create(cwd, { session: id, kind, prompt, agent: session.title }))
                    .then(() => this.options.onSaved?.(cwd))
                    .catch(error => console.warn(`[checkpoints] The checkpoint of ${cwd} failed: ${error instanceof Error ? error.message : String(error)}`));
                this.chains.set(cwd, next);
                void next.finally(() => {
                    if (this.chains.get(cwd) === next) this.chains.delete(cwd);
                });
            });
    }
}
