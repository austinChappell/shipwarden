import { ciStateOf, overviewState, type CiState, type IdleReason } from './agent-overview';
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

/** The user started work on a task in a new worktree ("Start in worktree", the queue, or Compare agents). */
export interface StatsStartEvent extends StatsEventBase, StatsAgent {
    type: 'start';
    worktree: string;
    /** The task, as its key and title. */
    task?: string;
}

/** The CI states that the log keeps. A pull request without checks adds no line. */
export type StatsCiState = Exclude<CiState, 'none'>;

const CI_STATES: readonly string[] = ['running', 'failed', 'passed'] satisfies StatsCiState[];

/**
 * The CI state of the pull request of a worktree changed. The page writes it from the pull request data that it has
 * already. It sends no request for it.
 */
export interface StatsCiEvent extends StatsEventBase {
    type: 'ci';
    worktree: string;
    /** The repository, as `owner/name`, when it is known. */
    repo?: string;
    /** The number of the pull request. */
    number: number;
    /** The head commit of the pull request. */
    sha: string;
    ci: StatsCiState;
}

/** The start of work on a task, from the page. */
export interface StatsStart {
    worktree: string;
    /** The name of the agent in Settings › Agents. */
    agent?: string;
    /** The task, as its key and title. */
    task?: string;
}

/** The CI state of the pull request of a worktree, from the pull request data of the page. */
export interface StatsCiChange {
    worktree: string;
    number: number;
    sha: string;
    ci: StatsCiState;
}

export type StatsEvent = StatsStateEvent | StatsMergeEvent | StatsCompareEvent | StatsStartEvent | StatsCiEvent;

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
        case 'start':
            return typeof value.worktree === 'string' ? (value as unknown as StatsStartEvent) : undefined;
        case 'ci':
            return typeof value.worktree === 'string' &&
                typeof value.number === 'number' &&
                typeof value.sha === 'string' &&
                typeof value.ci === 'string' &&
                CI_STATES.includes(value.ci)
                ? (value as unknown as StatsCiEvent)
                : undefined;
        default:
            return undefined;
    }
}

/** Reads a start from the page. Undefined when the value is not valid. */
export function parseStatsStart(value: unknown): StatsStart | undefined {
    const item = record(value);
    if (!item || typeof item.worktree !== 'string' || !item.worktree) return undefined;
    return {
        worktree: item.worktree,
        ...(typeof item.agent === 'string' && item.agent ? { agent: item.agent } : {}),
        ...(typeof item.task === 'string' && item.task ? { task: item.task } : {})
    };
}

/** Reads a CI change from the page. Undefined when the value is not valid. */
export function parseStatsCi(value: unknown): StatsCiChange | undefined {
    const item = record(value);
    if (!item || typeof item.worktree !== 'string' || !item.worktree) return undefined;
    if (typeof item.number !== 'number' || !Number.isInteger(item.number) || typeof item.sha !== 'string' || !item.sha) return undefined;
    if (typeof item.ci !== 'string' || !CI_STATES.includes(item.ci)) return undefined;
    return { worktree: item.worktree, number: item.number, sha: item.sha, ci: item.ci as StatsCiState };
}

/**
 * Gives the CI line of a worktree from the summary of its pull request. Undefined when the pull request has no head
 * commit, no checks, or no known state.
 */
export function statsCiChange(worktree: string, summary: { number: number; headSha?: string; checks: string | null } | undefined): StatsCiChange | undefined {
    if (!summary?.headSha) return undefined;
    const ci = ciStateOf(summary.checks);
    if (!ci || ci === 'none') return undefined;
    return { worktree, number: summary.number, sha: summary.headSha, ci };
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

// The math of the Stats view. All the functions are pure. The view gives them the events of the log and the time.

const DAY_MS = 24 * 60 * 60 * 1000;

/** The time ranges of the Stats view, in days. */
export const STATS_WINDOWS = [7, 30, 90] as const;

export type StatsWindow = (typeof STATS_WINDOWS)[number];

/** The rows of the Stats view: one row for each agent, or one row for each model. */
export type StatsGroupBy = 'agent' | 'model';

export const UNKNOWN_AGENT = 'Unknown agent';
export const UNKNOWN_MODEL = 'Unknown model';

/**
 * The longest time that one state counts. The log has no line when the app closes, so the last state of a session
 * has no end. A longer state counts as this time only.
 */
export const MAX_STATE_MS = 12 * 60 * 60 * 1000;

/** Gives the median of the values. Undefined for no values. */
export function median(values: readonly number[]): number | undefined {
    if (values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Gives `part / whole`. Undefined when `whole` is 0, because then the rate is not known. */
export function rate(part: number, whole: number): number | undefined {
    return whole > 0 ? part / whole : undefined;
}

/** Gives the start of the time range of the last `days` days. */
export function statsWindowStart(now: number, days: number): number {
    return now - days * DAY_MS;
}

/** The numbers of one agent or one model, in one time range. A value is undefined when the log has no data for it. */
export interface StatsRow {
    /** The agent name or the model. */
    label: string;
    /** The pull requests that the user merged in ShipWarden. */
    merged: number;
    /** The median of the tokens of each merged pull request. Only the pull requests with a token count count. */
    tokensPerPr?: number;
    /** The merged pull requests with a token count. */
    tokenPrs: number;
    /** The median time from the start of the work to the merge. */
    mergeMs?: number;
    /** The merged pull requests with a known start. */
    timedPrs: number;
    /** All the time of the agents, from their states. */
    agentMs: number;
    /** The time in "needs input": the agent waits for a permission, a question, or a prompt. */
    needsInputMs: number;
    /** The time in "blocked on CI": the agent finished its turn, and the checks run or failed. */
    blockedCiMs: number;
    needsInputShare?: number;
    blockedCiShare?: number;
    /** The pull requests with a known CI result for their first push. */
    firstPushes: number;
    /** The pull requests whose first push failed CI. */
    firstPushFailures: number;
    firstPushFailRate?: number;
    /** The comparisons that this agent or model won ("Keep this one"). */
    compareWins: number;
    /** The comparisons that this agent or model was in. */
    compareRuns: number;
}

export interface StatsSummary {
    /** All the agents together. The compare numbers count each comparison one time. */
    total: StatsRow;
    /** One row for each agent or model. The row with the most merged pull requests comes first. */
    rows: StatsRow[];
    /** True when the log has no event in the time range. */
    empty: boolean;
}

export interface StatsOptions {
    now: number;
    days: number;
    groupBy: StatsGroupBy;
}

interface Who {
    agent?: string;
    model?: string;
}

interface Acc {
    label: string;
    merged: number;
    tokens: number[];
    mergeMs: number[];
    agentMs: number;
    needsInputMs: number;
    blockedCiMs: number;
    firstPushes: number;
    firstPushFailures: number;
    compareWins: number;
    compareRuns: number;
}

function newAcc(label: string): Acc {
    return {
        label,
        merged: 0,
        tokens: [],
        mergeMs: [],
        agentMs: 0,
        needsInputMs: 0,
        blockedCiMs: 0,
        firstPushes: 0,
        firstPushFailures: 0,
        compareWins: 0,
        compareRuns: 0
    };
}

function finish(acc: Acc): StatsRow {
    return {
        label: acc.label,
        merged: acc.merged,
        tokensPerPr: median(acc.tokens),
        tokenPrs: acc.tokens.length,
        mergeMs: median(acc.mergeMs),
        timedPrs: acc.mergeMs.length,
        agentMs: acc.agentMs,
        needsInputMs: acc.needsInputMs,
        blockedCiMs: acc.blockedCiMs,
        needsInputShare: rate(acc.needsInputMs, acc.agentMs),
        blockedCiShare: rate(acc.blockedCiMs, acc.agentMs),
        firstPushes: acc.firstPushes,
        firstPushFailures: acc.firstPushFailures,
        firstPushFailRate: rate(acc.firstPushFailures, acc.firstPushes),
        compareWins: acc.compareWins,
        compareRuns: acc.compareRuns
    };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
}

/** The last event of the list at or before `at`. The list is in time order. */
function lastAtOrBefore<E extends { at: number }>(list: readonly E[] | undefined, at: number): E | undefined {
    let found: E | undefined;
    for (const item of list ?? []) {
        if (item.at > at) break;
        found = item;
    }
    return found;
}

/**
 * Computes the numbers of the Stats view for the last `days` days, for each agent or each model.
 *
 * - A merge counts in the range of its time. Its worktree comes from the event, or from the CI lines of the same pull
 *   request. The work on the pull request starts after the merge before it in the same worktree.
 * - The agent of a merge is the agent of "Start in worktree". Without a start line, it is the first agent with a state
 *   in the worktree. The model comes from the states of the agent.
 * - The time to merge starts at "Start in worktree", or else at the first state in the worktree.
 * - The tokens of a merge are the tokens of all the sessions in the worktree during the work.
 * - Each state lasts until the next state of its session. The last state lasts until the next merge in its worktree,
 *   or until now. A state counts `MAX_STATE_MS` at most. An exited agent counts no time.
 * - The first push of a pull request is the head commit of its first CI line. Its result is its first "passed" or
 *   "failed" line.
 */
export function computeStats(events: readonly StatsEvent[], { now, days, groupBy }: StatsOptions): StatsSummary {
    const since = statsWindowStart(now, days);
    const inRange = (at: number) => at >= since && at <= now;
    const sorted = [...events].sort((a, b) => a.at - b.at);

    const sessions = new Map<string, StatsStateEvent[]>();
    const statesByWorktree = new Map<string, StatsStateEvent[]>();
    const startsByWorktree = new Map<string, StatsStartEvent[]>();
    const mergesByWorktree = new Map<string, StatsMergeEvent[]>();
    const ciByWorktree = new Map<string, StatsCiEvent[]>();
    const ciByPr = new Map<string, StatsCiEvent[]>();
    const worktreeOfPr = new Map<string, string>();
    const merges: { event: StatsMergeEvent; worktree?: string }[] = [];
    const compares: StatsCompareEvent[] = [];

    for (const event of sorted) {
        switch (event.type) {
            case 'state':
                push(sessions, event.session, event);
                if (event.worktree) push(statesByWorktree, event.worktree, event);
                break;
            case 'start':
                push(startsByWorktree, event.worktree, event);
                break;
            case 'ci':
                push(ciByWorktree, event.worktree, event);
                push(ciByPr, `${event.worktree}#${event.number}`, event);
                if (event.repo) worktreeOfPr.set(`${event.repo}#${event.number}`, event.worktree);
                break;
            case 'merge':
                merges.push({ event });
                break;
            case 'compare':
                compares.push(event);
                break;
        }
    }
    for (const merge of merges) {
        merge.worktree = merge.event.worktree ?? (merge.event.repo ? worktreeOfPr.get(`${merge.event.repo}#${merge.event.number}`) : undefined);
        if (merge.worktree) push(mergesByWorktree, merge.worktree, merge.event);
    }

    // The agent and the model of each session. A session can tell its model in a later state.
    const sessionWho = new Map<string, Who>();
    for (const [id, list] of sessions) {
        const who: Who = {};
        for (const event of list) {
            if (event.agent) who.agent = event.agent;
            if (event.model) who.model = event.model;
        }
        sessionWho.set(id, who);
    }

    /** The time of the merge before `at` in the worktree, or -Infinity. */
    const workStart = (worktree: string, at: number): number => {
        let from = Number.NEGATIVE_INFINITY;
        for (const merge of mergesByWorktree.get(worktree) ?? []) {
            if (merge.at >= at) break;
            from = merge.at;
        }
        return from;
    };
    const between = <E extends { at: number }>(list: readonly E[] | undefined, from: number, to: number) =>
        (list ?? []).filter(item => item.at > from && item.at <= to);

    /** The agent and the model of the work in a worktree between two times. */
    const whoWorked = (worktree: string, from: number, to: number): Who => {
        const start = between(startsByWorktree.get(worktree), from, to).at(-1);
        const states = between(statesByWorktree.get(worktree), from, to);
        const agent = start?.agent ?? (states[0] ? sessionWho.get(states[0].session)?.agent : undefined);
        const session = states.find(event => sessionWho.get(event.session)?.agent === agent) ?? states[0];
        const model = start?.model ?? (session ? sessionWho.get(session.session)?.model : undefined);
        return { agent, model };
    };

    const rows = new Map<string, Acc>();
    const total = newAcc('All agents');
    const keyOf = (who: Who) => (groupBy === 'agent' ? (who.agent ?? UNKNOWN_AGENT) : (who.model ?? UNKNOWN_MODEL));
    const accOf = (who: Who): Acc => {
        const key = keyOf(who);
        let acc = rows.get(key);
        if (!acc) {
            acc = newAcc(key);
            rows.set(key, acc);
        }
        return acc;
    };
    let any = false;

    // Merges: the count, the tokens, and the time to merge.
    for (const { event, worktree } of merges) {
        if (!inRange(event.at)) continue;
        any = true;
        if (!worktree) {
            accOf({}).merged++;
            total.merged++;
            continue;
        }
        const from = workStart(worktree, event.at);
        const targets = [accOf(whoWorked(worktree, from, event.at)), total];
        const states = between(statesByWorktree.get(worktree), from, event.at);
        const startAt = between(startsByWorktree.get(worktree), from, event.at).at(-1)?.at ?? states[0]?.at;
        const tokens = mergeTokens(states, sessions, from);
        for (const acc of targets) {
            acc.merged++;
            if (startAt !== undefined) acc.mergeMs.push(event.at - startAt);
            if (tokens !== undefined) acc.tokens.push(tokens);
        }
    }

    // States: the time of the agents, in "needs input", and in "blocked on CI".
    for (const [id, list] of sessions) {
        const who = sessionWho.get(id) ?? {};
        for (const [index, event] of list.entries()) {
            if (event.state === 'exited') continue;
            const next = list[index + 1];
            const worktree = event.worktree;
            let end = next?.at;
            if (end === undefined) {
                const merge = worktree ? mergesByWorktree.get(worktree)?.find(item => item.at > event.at) : undefined;
                end = merge ? Math.min(merge.at, now) : now;
            }
            end = Math.min(end, event.at + MAX_STATE_MS, now);
            const begin = Math.max(event.at, since);
            if (end <= begin) continue;
            any = true;
            const acc = accOf(who);
            for (const piece of ciPieces(worktree ? ciByWorktree.get(worktree) : undefined, begin, end)) {
                const length = piece.end - piece.begin;
                const state = overviewState({ agentState: event.state, ci: piece.ci, now: piece.begin });
                for (const target of [acc, total]) {
                    target.agentMs += length;
                    if (state === 'waiting') target.needsInputMs += length;
                    if (state === 'blocked-ci') target.blockedCiMs += length;
                }
            }
        }
    }

    // First pushes: the CI result of the first head commit of each pull request.
    for (const list of ciByPr.values()) {
        const first = list[0];
        if (!inRange(first.at)) continue;
        any = true;
        const result = list.find(item => item.sha === first.sha && item.ci !== 'running');
        if (!result) continue;
        const from = workStart(first.worktree, first.at);
        for (const acc of [accOf(whoWorked(first.worktree, from, first.at)), total]) {
            acc.firstPushes++;
            if (result.ci === 'failed') acc.firstPushFailures++;
        }
    }

    // Comparisons: the wins of each agent or model.
    for (const compare of compares) {
        if (!inRange(compare.at)) continue;
        any = true;
        const keyOfRun = (run: StatsCompareRun) =>
            groupBy === 'agent' ? { agent: run.agentName } : { model: whoWorked(run.worktree, Number.NEGATIVE_INFINITY, compare.at).model };
        for (const run of compare.runs) {
            accOf(keyOfRun(run)).compareRuns++;
            total.compareRuns++;
        }
        accOf(keyOfRun(compare.winner)).compareWins++;
        total.compareWins++;
    }

    const list = [...rows.values()].map(finish).sort((a, b) => b.merged - a.merged || b.agentMs - a.agentMs || a.label.localeCompare(b.label));
    return { total: finish(total), rows: list, empty: !any };
}

/**
 * The tokens of the sessions of a pull request: for each session, its highest count in the work, less its count before
 * the work. Undefined when no session has a count.
 */
function mergeTokens(states: readonly StatsStateEvent[], sessions: ReadonlyMap<string, StatsStateEvent[]>, from: number): number | undefined {
    const highest = new Map<string, number>();
    for (const event of states) {
        if (event.tokens === undefined) continue;
        highest.set(event.session, Math.max(highest.get(event.session) ?? 0, event.tokens));
    }
    if (highest.size === 0) return undefined;
    let sum = 0;
    for (const [id, tokens] of highest) {
        const before = (sessions.get(id) ?? []).filter(event => event.at <= from).reduce((max, event) => Math.max(max, event.tokens ?? 0), 0);
        sum += Math.max(0, tokens - before);
    }
    return sum;
}

/** Cuts a time span into pieces with one CI state each. The CI state of a time is the last CI line at or before it. */
function ciPieces(ci: readonly StatsCiEvent[] | undefined, begin: number, end: number): { begin: number; end: number; ci?: CiState }[] {
    const pieces: { begin: number; end: number; ci?: CiState }[] = [];
    let at = begin;
    let state: CiState | undefined = lastAtOrBefore(ci, begin)?.ci;
    for (const item of ci ?? []) {
        if (item.at <= begin) continue;
        if (item.at >= end) break;
        pieces.push({ begin: at, end: item.at, ci: state });
        at = item.at;
        state = item.ci;
    }
    pieces.push({ begin: at, end, ci: state });
    return pieces.filter(piece => piece.end > piece.begin);
}

/** Gives a part as a percent, for example "12%". A part above 0 and below 0.5% is "<1%". Undefined stays undefined. */
export function formatShare(share: number | undefined): string | undefined {
    if (share === undefined) return undefined;
    if (share > 0 && share < 0.005) return '<1%';
    return `${Math.round(share * 100)}%`;
}
