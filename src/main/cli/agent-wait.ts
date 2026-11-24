import type { AgentState } from '@shared/agents';
import type { TerminalSession } from '@shared/terminal';
import { CliError } from './cli-server';

/** The states of an agent that works on a turn. The wait continues in these states. */
const BUSY_STATES: ReadonlySet<AgentState | undefined> = new Set<AgentState | undefined>(['starting', 'working']);

/** The default time of `agent wait`. */
export const DEFAULT_WAIT_MS = 30 * 60_000;
/** The longest time of `agent wait`. */
export const MAX_WAIT_MS = 24 * 60 * 60_000;
/** After a prompt, the agent gets this time to start its turn. Its state can stay "idle" for this time. */
export const START_GRACE_MS = 15_000;
const POLL_MS = 1000;

export interface WaitForAgentOptions {
    sessions(): Promise<TerminalSession[]>;
    worktree: string;
    /** Wait for this session only. Else wait for all agents of the worktree. */
    sessionId?: string;
    /**
     * The time of the prompt, in milliseconds. Until the agent changes its state after this time, or until the grace
     * time ends, an idle agent counts as busy. So a wait right after a prompt does not end before the turn starts.
     */
    after?: number;
    timeoutMs: number;
    signal: AbortSignal;
    graceMs?: number;
    pollMs?: number;
    now?(): number;
    sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

/** The result of a wait: the agent and the state at the end. */
export interface WaitResult {
    sessionId: string;
    title: string;
    state: AgentState | 'unknown';
    message?: string;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done, { once: true });
        function done() {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        }
    });
}

function resultOf(session: TerminalSession): WaitResult {
    return {
        sessionId: session.id,
        title: session.title,
        state: session.exited ? 'exited' : (session.agentState ?? 'unknown'),
        ...(session.agentMessage ? { message: session.agentMessage } : {})
    };
}

/**
 * Waits until the agent finishes its turn: it is idle, done, waiting for input, or exited. An agent without hooks has
 * no state, so the wait ends at once. Throws a CliError at the timeout, or when the worktree has no agent.
 */
export async function waitForAgent(options: WaitForAgentOptions): Promise<WaitResult> {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? defaultSleep;
    const graceMs = options.graceMs ?? START_GRACE_MS;
    const start = now();
    for (;;) {
        if (options.signal.aborted) throw new CliError('failed', 'The wait was cancelled.');
        const all = await options.sessions();
        const agents = options.sessionId
            ? all.filter(session => session.id === options.sessionId)
            : all.filter(session => session.isAgent && !session.exited && session.worktreePath === options.worktree);
        if (agents.length === 0) {
            throw new CliError('notFound', options.sessionId ? 'The agent tab closed.' : `No agent is running in ${options.worktree}.`);
        }
        const live = agents.filter(session => !session.exited);
        const busy = live.some(session => BUSY_STATES.has(session.agentState));
        const after = options.after;
        const notStarted = after !== undefined && now() - after < graceMs && live.length > 0 && live.every(session => (session.agentStateAt ?? 0) < after);
        if (!busy && !notStarted) {
            const newest = [...agents].sort((a, b) => (b.agentStateAt ?? 0) - (a.agentStateAt ?? 0))[0];
            return resultOf(newest);
        }
        if (now() - start >= options.timeoutMs) {
            throw new CliError('timeout', `The agent is still working after ${Math.round(options.timeoutMs / 1000)} seconds.`);
        }
        await sleep(options.pollMs ?? POLL_MS, options.signal);
    }
}

/** Returns the wait time in milliseconds for a "timeout" value in seconds. A wrong value gives the default. */
export function waitTimeoutMs(seconds: unknown): number {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return DEFAULT_WAIT_MS;
    return Math.min(MAX_WAIT_MS, Math.round(seconds * 1000));
}
