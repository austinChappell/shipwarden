import type { IdleReason } from './agent-overview';
import type { AgentState, AgentWaitKind } from './agents';

/**
 * The event log of the agent stats (`agent-stats.jsonl` in the app data folder). Each line is one JSON event.
 * The main process writes a line at each agent state change, each pull request merge, and each compare result.
 * The Stats view reads the log. It does not read the transcripts again.
 *
 * The functions of this module use no Electron API and no Node API. The main process and the page both use them.
 */

/** The version of the events. Change it when a change breaks the reader of old lines. */
export const STATS_LOG_VERSION = 1;

/** The log keeps the events of this number of days. The app removes older lines at start. */
export const STATS_RETENTION_DAYS = 90;

export const STATS_RETENTION_MS = STATS_RETENTION_DAYS * 24 * 60 * 60 * 1000;

interface StatsEventBase {
    /** The version of the event (`STATS_LOG_VERSION`). */
    v: number;
    /** The time of the event, in milliseconds. */
    at: number;
}

/** The fields that tell which agent did the work. */
export interface StatsAgent {
    /** The worktree of the agent. */
    worktree?: string;
    /** The repository, as `owner/name` (`repoId`). Undefined when the "origin" remote is not known. */
    repo?: string;
    /** The agent program, for example "claude" or "codex". */
    program?: string;
    /** The name of the agent in Settings › Agents, for example "Claude Code". It is the title of its tab. */
    agent?: string;
    /** The model, for example "claude-sonnet-4-5". Only some agents tell it. */
    model?: string;
}

/** An agent changed its state. */
export interface StatsStateEvent extends StatsEventBase, StatsAgent {
    type: 'state';
    /** The ID of the terminal session. */
    session: string;
    state: AgentState;
    /** What a waiting agent waits for. */
    waitFor?: AgentWaitKind;
    /** Why the agent does not work. The main process does not know the CI state, so the reason has no CI part. */
    reason?: IdleReason;
    /** The transcript file of a Claude Code session. */
    transcript?: string;
    /** All the tokens of the session up to this event. Only Claude Code sessions have a count. */
    tokens?: number;
}

/** The user merged a pull request in ShipWarden. */
export interface StatsMergeEvent extends StatsEventBase, StatsAgent {
    type: 'merge';
    number: number;
    url?: string;
    /** The merge method: merge, squash, or rebase. */
    method?: string;
}

/** One agent of a comparison. */
export interface StatsCompareRun {
    agentId: string;
    agentName: string;
    worktree: string;
}

/** The user kept one run of a comparison ("Keep this one"). */
export interface StatsCompareEvent extends StatsEventBase {
    type: 'compare';
    /** The ID of the comparison. */
    compare: string;
    /** The main worktree of the repository. */
    repoPath: string;
    /** The repository, as `owner/name`, when it is known. */
    repo?: string;
    /** The task title. */
    task: string;
    winner: StatsCompareRun;
    runs: StatsCompareRun[];
}

export type StatsEvent = StatsStateEvent | StatsMergeEvent | StatsCompareEvent;

/** An event without the version. The store adds it. */
export type NewStatsEvent = StatsEvent extends infer E ? (E extends StatsEvent ? Omit<E, 'v'> : never) : never;

function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Reads one line of the log. Returns undefined for a line that is not a valid event, for example a line that a crash
 * cut, or an event of a newer version.
 */
export function parseStatsLine(line: string): StatsEvent | undefined {
    if (!line.trim()) return undefined;
    let value: Record<string, unknown> | undefined;
    try {
        value = record(JSON.parse(line));
    } catch {
        return undefined;
    }
    if (!value || typeof value.at !== 'number' || !Number.isFinite(value.at) || value.v !== STATS_LOG_VERSION) return undefined;
    switch (value.type) {
        case 'state':
            return typeof value.session === 'string' && typeof value.state === 'string' ? (value as unknown as StatsStateEvent) : undefined;
        case 'merge':
            return typeof value.number === 'number' ? (value as unknown as StatsMergeEvent) : undefined;
        case 'compare':
            return typeof value.compare === 'string' && record(value.winner) && Array.isArray(value.runs) ? (value as unknown as StatsCompareEvent) : undefined;
        default:
            return undefined;
    }
}

/** Gives the JSON line of an event, with its end of line. Fields with an undefined value are not in the line. */
export function statsLine(event: NewStatsEvent): string {
    return `${JSON.stringify({ v: STATS_LOG_VERSION, ...event })}\n`;
}

/**
 * Gives the lines of the log to keep: the lines of the events at or after `since`.
 * A line that is not a valid event goes too.
 */
export function linesToKeep(text: string, since: number): string[] {
    return text.split('\n').filter(line => {
        const event = parseStatsLine(line);
        return !!event && event.at >= since;
    });
}
