import type { AgentState } from './agents';

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
