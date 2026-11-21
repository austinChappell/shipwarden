import type { AgentState, AgentWaitKind } from './agents';

/**
 * The state of an agent in the Agents view.
 * - waiting: the agent needs the user. It asks a question or a permission, or it has no prompt yet.
 * - blocked-ci: the agent finished its turn, and the checks of its pull request run or failed.
 * - working: the agent works on a prompt.
 * - starting: the agent process started, but the agent did not report yet.
 * - done: the agent finished its turn. Its pull request has no failed or running checks.
 * - quiet: the agent has no hooks and sent no output recently. ShipWarden does not know its state.
 */
export type OverviewState = 'waiting' | 'blocked-ci' | 'working' | 'starting' | 'done' | 'quiet';

export const OVERVIEW_LABELS: Record<OverviewState, string> = {
    waiting: 'Needs input',
    'blocked-ci': 'Blocked on CI',
    working: 'Working',
    starting: 'Starting',
    done: 'Done',
    quiet: 'Quiet'
};

/** The order of the states in a list. The first state needs the user most. */
export const OVERVIEW_ORDER: readonly OverviewState[] = ['waiting', 'blocked-ci', 'working', 'starting', 'quiet', 'done'];

/**
 * The CI state of the pull request of an agent's branch.
 * - failed: one or more checks failed.
 * - running: checks run, and none failed.
 * - passed: all checks passed.
 * - none: the pull request has no checks.
 */
export type CiState = 'failed' | 'running' | 'passed' | 'none';

/** An agent without hooks that sent output in this time is "working". */
export const ACTIVE_OUTPUT_MS = 10_000;

/**
 * Converts the combined check state of a pull request to a CI state.
 * `checks` is the value of `BranchSummary.checks`: SUCCESS, FAILURE, ERROR, PENDING, EXPECTED or null.
 * Returns undefined when the branch has no pull request (`undefined`) or the value is not known.
 */
export function ciStateOf(checks: string | null | undefined): CiState | undefined {
    if (checks === undefined) return undefined;
    if (checks === null) return 'none';
    switch (checks.toUpperCase()) {
        case 'FAILURE':
        case 'ERROR':
            return 'failed';
        case 'PENDING':
        case 'EXPECTED':
            return 'running';
        case 'SUCCESS':
            return 'passed';
        default:
            return undefined;
    }
}

export interface OverviewInput {
    /** The state from the agent hooks. Undefined for an agent without hooks. */
    agentState?: AgentState;
    /** The CI state of the pull request of the agent's branch. Undefined when the branch has no pull request. */
    ci?: CiState;
    /** The time of the last terminal output of the agent, in milliseconds. */
    lastOutputAt?: number;
    /** The time now, in milliseconds. */
    now: number;
}

function blockedOnCi(ci: CiState | undefined): boolean {
    return ci === 'failed' || ci === 'running';
}

/**
 * Gives the state of an agent for the Agents view.
 * The hook state wins. When the agent's turn is over, the CI state of its pull request decides.
 * An agent without hooks is "working" while its terminal sends output.
 */
export function overviewState({ agentState, ci, lastOutputAt, now }: OverviewInput): OverviewState {
    switch (agentState) {
        case 'waiting':
            return 'waiting';
        case 'working':
            return 'working';
        case 'starting':
            return 'starting';
        case 'idle':
            return blockedOnCi(ci) ? 'blocked-ci' : 'waiting';
        case 'done':
        case 'exited':
            return blockedOnCi(ci) ? 'blocked-ci' : 'done';
        case undefined:
            if (lastOutputAt !== undefined && now - lastOutputAt < ACTIVE_OUTPUT_MS) return 'working';
            return blockedOnCi(ci) ? 'blocked-ci' : 'quiet';
    }
}

/**
 * Why an agent does not work. The Agents view and the phone show it for each state other than "working" and "starting".
 * - permission, question, input: the agent waits for the user. The hook notification tells which.
 * - prompt: the agent started and has no prompt yet.
 * - reply: the agent finished its turn and waits for the next prompt.
 * - ci-running, ci-failed: the agent finished its turn, and the checks of its pull request run or failed.
 * - session-ended: the agent session ended. The terminal still runs a shell.
 * - process-stopped, process-failed: the terminal process stopped with exit code 0, or with another exit code.
 * - no-report: the agent has no hooks and sent no output recently.
 */
export type IdleReason =
    | 'permission'
    | 'question'
    | 'input'
    | 'prompt'
    | 'reply'
    | 'ci-running'
    | 'ci-failed'
    | 'session-ended'
    | 'process-stopped'
    | 'process-failed'
    | 'no-report';

export const IDLE_REASON_TEXT: Record<IdleReason, string> = {
    permission: 'Waiting for a permission prompt',
    question: 'The agent is asking a question',
    input: 'Waiting for your input',
    prompt: 'Waiting for your first prompt',
    reply: 'Waiting for your reply',
    'ci-running': 'Waiting for CI',
    'ci-failed': 'CI failed. Waiting for your reply',
    'session-ended': 'The agent session ended',
    'process-stopped': 'The process stopped',
    'process-failed': 'The process stopped with an error',
    'no-report': 'No recent output. This agent does not report its state'
};

export interface IdleReasonInput extends OverviewInput {
    /** What a waiting agent waits for, from its hooks. */
    waitFor?: AgentWaitKind;
    /** True when the terminal process stopped. */
    exited?: boolean;
    /** The exit code of the terminal process. */
    exitCode?: number;
}

/**
 * Gives the reason why an agent does not work. Undefined when the agent works or starts.
 * The order of the checks is the same as in `overviewState`: the hook state, then the CI state, then the process.
 */
export function idleReason(input: IdleReasonInput): IdleReason | undefined {
    const state = overviewState(input);
    if (state === 'working' || state === 'starting') return undefined;
    if (state === 'blocked-ci') return input.ci === 'failed' ? 'ci-failed' : 'ci-running';
    switch (input.agentState) {
        case 'waiting':
            return input.waitFor ?? 'input';
        case 'idle':
            return 'prompt';
        case 'done':
            return 'reply';
        default:
            break;
    }
    if (input.exited) return input.exitCode ? 'process-failed' : 'process-stopped';
    if (input.agentState === 'exited') return 'session-ended';
    return 'no-report';
}

/** Gives the text of the reason why an agent does not work. Undefined when the agent works or starts. */
export function idleReasonText(input: IdleReasonInput): string | undefined {
    const reason = idleReason(input);
    return reason ? IDLE_REASON_TEXT[reason] : undefined;
}

/** Gives a short text about the CI state, for example "CI failed". Undefined when there is no pull request. */
export function ciText(ci: CiState | undefined): string | undefined {
    switch (ci) {
        case 'failed':
            return 'CI failed';
        case 'running':
            return 'CI running';
        case 'passed':
            return 'CI passed';
        case 'none':
            return 'No checks';
        default:
            return undefined;
    }
}

/**
 * Gives the time of the last sign of life of an agent: its last output or its last state change, the newer one.
 * Undefined when both are not known.
 */
export function lastActivityAt(lastOutputAt: number | undefined, stateAt: number | undefined): number | undefined {
    if (lastOutputAt === undefined) return stateAt;
    if (stateAt === undefined) return lastOutputAt;
    return Math.max(lastOutputAt, stateAt);
}

/** Gives the time between two moments as text, for example "8s", "3m 05s", "2h 5m" or "1d 3h". */
export function formatElapsed(from: number | undefined, now: number): string | undefined {
    if (from === undefined) return undefined;
    const seconds = Math.max(0, Math.floor((now - from) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Compares two agents for a list. The state that needs the user most comes first.
 * In one state, the agent with the oldest activity comes first, because it waited longest.
 */
export function compareOverview(a: { state: OverviewState; activityAt?: number }, b: { state: OverviewState; activityAt?: number }): number {
    return OVERVIEW_ORDER.indexOf(a.state) - OVERVIEW_ORDER.indexOf(b.state) || (a.activityAt ?? 0) - (b.activityAt ?? 0);
}

/** Counts the agents in each state. The list has only the states that have agents, in list order. */
export function countStates(states: readonly OverviewState[]): { state: OverviewState; count: number }[] {
    return OVERVIEW_ORDER.map(state => ({ state, count: states.filter(item => item === state).length })).filter(item => item.count > 0);
}
