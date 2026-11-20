import type { StatusCategory, Task, TaskLabel } from './tasks';
import { pluralize } from './format';

/**
 * The task queue: a list of tasks that ShipWarden starts one after the other. At most `maxRunning` agents of the queue
 * work at the same time. When an agent finishes, the next task starts. The queue is global. Each item keeps its own
 * repository.
 *
 * The functions of this module are the scheduler. They use no Electron API and no browser API, so the unit tests
 * run them directly. Each function returns a new state and does not change its input.
 */

/**
 * The state of one item.
 * - queued: the item waits for a free place.
 * - starting: ShipWarden makes the worktree and starts the agent now.
 * - running: the agent works. The item uses a place until the agent finishes.
 * - done: the agent finished. See `finishReason`.
 * - failed: the start failed `MAX_START_ATTEMPTS` times. The item does not start again without the user.
 */
export type QueueItemStatus = 'queued' | 'starting' | 'running' | 'done' | 'failed';

/**
 * When an agent of the queue is finished.
 * - pullRequest: the branch of the agent has a pull request.
 * - idle: the agent did not work for `idleMinutes`.
 * In both modes, an agent that exited is finished.
 */
export type QueueFinish = 'pullRequest' | 'idle';

export const QUEUE_FINISH_LABELS: Record<QueueFinish, string> = {
    pullRequest: 'The agent opened a pull request',
    idle: 'The agent is idle for the set time'
};

export const QUEUE_STATUS_LABELS: Record<QueueItemStatus, string> = {
    queued: 'Queued',
    starting: 'Starting',
    running: 'Running',
    done: 'Finished',
    failed: 'Failed'
};

export interface QueueSettings {
    /** The most agents of the queue that work at the same time. */
    maxRunning: number;
    finishWhen: QueueFinish;
    /** For `finishWhen: 'idle'`: the minutes without work after which the agent is finished. */
    idleMinutes: number;
    /** True when the queue starts no new items. The agents that work now continue. */
    paused: boolean;
}

/** One task in the queue. The task fields are a copy from the time when the user added the task. */
export interface QueueItem {
    id: string;
    connectionId: string;
    pluginId: string;
    task: Task;
    /** The main worktree of the repository of the new worktree. */
    repoPath: string;
    /** The ID of the agent in Settings › Agents. Undefined: the agent of the repository. */
    agentId?: string;
    /** The name of the automation that added the item. Undefined: the user added it. */
    addedBy?: string;
    status: QueueItemStatus;
    addedAt: number;
    updatedAt: number;
    /** The number of failed starts. */
    attempts: number;
    /** The error of the last failed start. */
    error?: string;
    /** A queued item after a failed start does not start before this time. */
    retryAt?: number;
    worktreePath?: string;
    branch?: string;
    sessionId?: string;
    startedAt?: number;
    finishedAt?: number;
    /** Why the item is finished, for example "The agent opened a pull request." */
    finishReason?: string;
}

export interface QueueState {
    /** The order of the queued items is the order of the queue. The other items keep their place. */
    items: QueueItem[];
    settings: QueueSettings;
}

/** The smallest and the largest limit of agents. */
export const QUEUE_MAX_RUNNING_MIN = 1;
export const QUEUE_MAX_RUNNING_MAX = 10;
/** The smallest and the largest idle time, in minutes. */
export const QUEUE_IDLE_MIN = 1;
export const QUEUE_IDLE_MAX = 24 * 60;
/** After this number of failed starts, the item stops with the status "failed". */
export const MAX_START_ATTEMPTS = 3;
/** A failed item waits this time before the next start. Then a broken item does not start again and again. */
export const RETRY_DELAY_MS = 60_000;
/** A new agent session can take this time to show in the session list. Before it, a missing session is not an exit. */
export const START_GRACE_MS = 60_000;
/** The file keeps at most this number of finished and failed items. The oldest go first. */
export const MAX_FINISHED_ITEMS = 200;

export const DEFAULT_QUEUE_SETTINGS: QueueSettings = { maxRunning: 2, finishWhen: 'pullRequest', idleMinutes: 15, paused: false };

export const EMPTY_QUEUE: QueueState = { items: [], settings: DEFAULT_QUEUE_SETTINGS };

/** The longest task description that an item keeps. The prompt of the agent uses it. */
const MAX_DESCRIPTION = 20_000;

/** The statuses of the items that use a place. */
const ACTIVE: ReadonlySet<QueueItemStatus> = new Set(['starting', 'running']);
/** The statuses of the items that are not closed. A task can be in the queue one time with one of these. */
const OPEN: ReadonlySet<QueueItemStatus> = new Set(['queued', 'starting', 'running']);

/* ------------------------------------------------------------------------------------------------------------------ */
/* Read and check                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

/** True when the item uses a place: it starts or runs. */
export function isActive(item: QueueItem): boolean {
    return ACTIVE.has(item.status);
}

/** True when the item is not closed: it waits, starts, or runs. */
export function isOpen(item: QueueItem): boolean {
    return OPEN.has(item.status);
}

/** The queued items in the order of the queue. */
export function queuedItems(state: QueueState): QueueItem[] {
    return state.items.filter(item => item.status === 'queued');
}

/** The number of items that use a place. */
export function activeCount(state: QueueState): number {
    return state.items.filter(isActive).length;
}

/** The open item of a task, if the task is in the queue. */
export function openItemOfTask(state: QueueState, connectionId: string, taskId: string): QueueItem | undefined {
    return state.items.find(item => isOpen(item) && item.connectionId === connectionId && item.task.id === taskId);
}

/** The place of a queued item in the queue, from 1. Undefined for an item that is not queued. */
export function queuePosition(state: QueueState, id: string): number | undefined {
    const index = queuedItems(state).findIndex(item => item.id === id);
    return index === -1 ? undefined : index + 1;
}

/** A short text for the header of the Queue page, for example "2 running · 5 queued". */
export function queueMeta(state: QueueState): string {
    const running = activeCount(state);
    const queued = queuedItems(state).length;
    const parts = [`${running} of ${state.settings.maxRunning} running`, queued > 0 ? `${queued} queued` : ''].filter(Boolean);
    return parts.join(' · ');
}

/** Returns a new ID for an item. */
export function newQueueItemId(now: number): string {
    return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The parts of a task that an item keeps: the parts of the branch name and the prompt. */
export function queueTaskSnapshot(task: Task): Task {
    const description = task.description?.slice(0, MAX_DESCRIPTION);
    return {
        id: task.id,
        ...(task.key ? { key: task.key } : {}),
        title: task.title,
        ...(task.url ? { url: task.url } : {}),
        status: { id: task.status.id, name: task.status.name, category: task.status.category },
        ...(task.labels?.length ? { labels: task.labels.map(label => ({ ...label })) } : {}),
        ...(description ? { description } : {})
    };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Changes of the user                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The data of a new item. */
export interface QueueInput {
    connectionId: string;
    pluginId: string;
    task: Task;
    repoPath: string;
    agentId?: string;
    addedBy?: string;
}

/**
 * Adds a task to the end of the queue. A task that is in the queue (queued, starting, or running) is not added again.
 * Then `added` is false, and `item` is the item that exists.
 */
export function addToQueue(state: QueueState, input: QueueInput, id: string, now: number): { state: QueueState; item: QueueItem; added: boolean } {
    const existing = openItemOfTask(state, input.connectionId, input.task.id);
    if (existing) return { state, item: existing, added: false };
    const item: QueueItem = {
        id,
        connectionId: input.connectionId,
        pluginId: input.pluginId,
        task: queueTaskSnapshot(input.task),
        repoPath: input.repoPath,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.addedBy ? { addedBy: input.addedBy } : {}),
        status: 'queued',
        addedAt: now,
        updatedAt: now,
        attempts: 0
    };
    return { state: { ...state, items: [...state.items, item] }, item, added: true };
}

/** Removes an item. The worktree and the agent of a running item stay. */
export function removeFromQueue(state: QueueState, id: string): QueueState {
    return { ...state, items: state.items.filter(item => item.id !== id) };
}

/**
 * Moves a queued item to the index `to` among the queued items. The other items keep their place in the list.
 * Returns the same state when the item is not queued or when `to` is out of the range.
 */
export function moveInQueue(state: QueueState, id: string, to: number): QueueState {
    const keys = queuedItems(state).map(item => item.id);
    const from = keys.indexOf(id);
    if (from === -1 || to < 0 || to >= keys.length || to === from) return state;
    const order = [...keys];
    order.splice(from, 1);
    order.splice(to, 0, id);
    const byId = new Map(state.items.map(item => [item.id, item]));
    let next = 0;
    const items = state.items.map(item => (item.status === 'queued' ? (byId.get(order[next++]) ?? item) : item));
    return { ...state, items };
}

/** Puts a failed item back at the end of the queue, with no failed starts. */
export function retryItem(state: QueueState, id: string, now: number): QueueState {
    const item = state.items.find(entry => entry.id === id);
    if (item?.status !== 'failed') return state;
    const { retryAt: _retryAt, error: _error, ...rest } = item;
    const retried: QueueItem = { ...rest, status: 'queued', attempts: 0, updatedAt: now };
    return { ...state, items: [...state.items.filter(entry => entry.id !== id), retried] };
}

/** Removes the finished and the failed items. */
export function clearFinished(state: QueueState): QueueState {
    return { ...state, items: state.items.filter(isOpen) };
}

/** Changes the settings. Each value is checked and kept in its range. */
export function changeQueueSettings(state: QueueState, change: Partial<QueueSettings>): QueueState {
    return { ...state, settings: normalizeQueueSettings({ ...state.settings, ...change }) };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Scheduler                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * A check before each start. It returns the reason why the queue must wait now, or undefined when the item can start.
 * A wait stops the queue for this round. The items stay queued, and the next round checks again. For example, a usage
 * budget can return "Waiting for usage to reset".
 */
export type StartCheck = (item: QueueItem, state: QueueState, now: number) => string | undefined;

/** The check that lets each item start. */
export const alwaysStart: StartCheck = () => undefined;

/** The result of `nextStarts`. */
export interface StartPlan {
    /** The items to start now, in the order of the queue. */
    items: QueueItem[];
    /** Why the queue waits, when a check stopped it. */
    waiting?: string;
}

/**
 * Returns the queued items that can start now. The number of items is at most the free places: `maxRunning` minus the
 * items that start or run. An item that waits after a failed start (`retryAt`) is skipped, and the next item can start.
 * `check` runs for each item in order. When it returns a reason, the queue stops there for this round.
 */
export function nextStarts(state: QueueState, now: number, check: StartCheck = alwaysStart): StartPlan {
    if (state.settings.paused) return { items: [] };
    const free = state.settings.maxRunning - activeCount(state);
    const items: QueueItem[] = [];
    if (free <= 0) return { items };
    for (const item of queuedItems(state)) {
        if (items.length >= free) break;
        if (item.retryAt !== undefined && item.retryAt > now) continue;
        const waiting = check(item, state, now);
        if (waiting) return { items, waiting };
        items.push(item);
    }
    return { items };
}

function changeItem(state: QueueState, id: string, change: (item: QueueItem) => QueueItem): QueueState {
    return { ...state, items: state.items.map(item => (item.id === id ? change(item) : item)) };
}

/** Marks a queued item as "starting". It uses a place from now on. */
export function markStarting(state: QueueState, id: string, now: number): QueueState {
    return changeItem(state, id, item => (item.status === 'queued' ? { ...item, status: 'starting', updatedAt: now } : item));
}

/** Marks a starting item as "running", with its worktree and its agent session. */
export function markStarted(state: QueueState, id: string, started: { worktreePath: string; branch?: string; sessionId: string }, now: number): QueueState {
    return changeItem(state, id, item => {
        if (item.status !== 'starting') return item;
        const { retryAt: _retryAt, ...rest } = item;
        return {
            ...rest,
            status: 'running',
            worktreePath: started.worktreePath,
            ...(started.branch ? { branch: started.branch } : {}),
            sessionId: started.sessionId,
            startedAt: now,
            updatedAt: now
        };
    });
}

/**
 * Records a failed start. The item goes to the end of the queue with its error, and waits `RETRY_DELAY_MS`. After
 * `MAX_START_ATTEMPTS` failed starts, the item gets the status "failed" and stays there.
 */
export function markStartFailed(state: QueueState, id: string, error: string, now: number): QueueState {
    const item = state.items.find(entry => entry.id === id);
    if (!item || (item.status !== 'starting' && item.status !== 'queued')) return state;
    const attempts = item.attempts + 1;
    const failed: QueueItem =
        attempts >= MAX_START_ATTEMPTS
            ? { ...item, status: 'failed', attempts, error, updatedAt: now, finishedAt: now }
            : { ...item, status: 'queued', attempts, error, updatedAt: now, retryAt: now + RETRY_DELAY_MS };
    return pruneFinished({ ...state, items: [...state.items.filter(entry => entry.id !== id), failed] });
}

/** Marks a running item as finished, with the reason. */
export function markFinished(state: QueueState, id: string, reason: string, now: number): QueueState {
    return pruneFinished(
        changeItem(state, id, item => (item.status === 'running' ? { ...item, status: 'done', finishReason: reason, finishedAt: now, updatedAt: now } : item))
    );
}

/** What the app sees of the agent of a running item. */
export interface AgentObservation {
    /** False when the session is not in the session list, or when it exited. */
    alive: boolean;
    /** True while the agent works, starts, or waits for the user. */
    busy: boolean;
    /** The time when the agent stopped its work, if it is not busy. Undefined when the app does not know. */
    quietSince?: number;
    /** True when the branch of the agent has a pull request. */
    hasPullRequest: boolean;
}

/**
 * Returns why a running item is finished, or undefined when its agent still uses the place.
 * - An agent that exited is finished, in both modes. A new session gets `START_GRACE_MS` to show in the list.
 * - "pullRequest": the branch has a pull request.
 * - "idle": the agent is not busy, and it stopped its work `idleMinutes` ago or earlier.
 */
export function finishReason(item: QueueItem, seen: AgentObservation, settings: QueueSettings, now: number): string | undefined {
    if (item.status !== 'running') return undefined;
    if (!seen.alive) {
        const young = item.startedAt !== undefined && now - item.startedAt < START_GRACE_MS;
        return young ? undefined : 'The agent exited.';
    }
    if (settings.finishWhen === 'pullRequest') return seen.hasPullRequest ? 'The agent opened a pull request.' : undefined;
    if (seen.busy || seen.quietSince === undefined) return undefined;
    return now - seen.quietSince >= settings.idleMinutes * 60_000 ? `The agent was idle for ${pluralize(settings.idleMinutes, 'minute')}.` : undefined;
}

/**
 * Prepares a queue that the app read at its start. A start that did not end (the app stopped during it) counts as a
 * failed start, so the item goes to the end of the queue. Running items stay running: their agents keep working
 * after a restart of the app, and `finishReason` finds the agents that stopped.
 */
export function recoverQueue(state: QueueState, now: number): QueueState {
    let next = state;
    for (const item of state.items.filter(entry => entry.status === 'starting')) {
        next = markStartFailed(next, item.id, 'ShipWarden stopped during the start.', now);
    }
    return next;
}

/** Keeps at most `MAX_FINISHED_ITEMS` closed items. The items with the oldest end go first. */
function pruneFinished(state: QueueState): QueueState {
    const closed = state.items.filter(item => !isOpen(item));
    if (closed.length <= MAX_FINISHED_ITEMS) return state;
    const keep = new Set(
        closed
            .sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt))
            .slice(0, MAX_FINISHED_ITEMS)
            .map(item => item.id)
    );
    return { ...state, items: state.items.filter(item => isOpen(item) || keep.has(item.id)) };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* File format                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

const STATUSES: readonly QueueItemStatus[] = ['queued', 'starting', 'running', 'done', 'failed'];
const CATEGORIES: readonly StatusCategory[] = ['backlog', 'todo', 'in_progress', 'done', 'canceled'];

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

function time(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeQueueSettings(value: unknown): QueueSettings {
    const raw = record(value);
    return {
        maxRunning: clamp(raw.maxRunning, QUEUE_MAX_RUNNING_MIN, QUEUE_MAX_RUNNING_MAX, DEFAULT_QUEUE_SETTINGS.maxRunning),
        finishWhen: raw.finishWhen === 'idle' ? 'idle' : 'pullRequest',
        idleMinutes: clamp(raw.idleMinutes, QUEUE_IDLE_MIN, QUEUE_IDLE_MAX, DEFAULT_QUEUE_SETTINGS.idleMinutes),
        paused: raw.paused === true
    };
}

function normalizeTask(value: unknown): Task | undefined {
    const raw = record(value);
    const id = text(raw.id);
    const title = typeof raw.title === 'string' ? raw.title : undefined;
    if (!id || title === undefined) return undefined;
    const status = record(raw.status);
    const category = CATEGORIES.find(item => item === status.category) ?? 'todo';
    const labels: TaskLabel[] = (Array.isArray(raw.labels) ? raw.labels : []).map(record).flatMap(label => {
        const name = text(label.name);
        if (!name) return [];
        return [{ name, ...(text(label.id) ? { id: text(label.id) } : {}), ...(text(label.color) ? { color: text(label.color) } : {}) }];
    });
    return queueTaskSnapshot({
        id,
        ...(text(raw.key) ? { key: text(raw.key) } : {}),
        title,
        ...(text(raw.url) ? { url: text(raw.url) } : {}),
        status: { id: text(status.id) ?? '', name: text(status.name) ?? '', category },
        ...(labels.length ? { labels } : {}),
        ...(text(raw.description) ? { description: text(raw.description) } : {})
    });
}

function normalizeItem(value: unknown): QueueItem | undefined {
    const raw = record(value);
    const id = text(raw.id);
    const connectionId = text(raw.connectionId);
    const pluginId = text(raw.pluginId);
    const repoPath = text(raw.repoPath);
    const task = normalizeTask(raw.task);
    const status = STATUSES.find(item => item === raw.status);
    const addedAt = time(raw.addedAt);
    if (!id || !connectionId || !pluginId || !repoPath || !task || !status || addedAt === undefined) return undefined;
    const optionalText = (key: 'agentId' | 'addedBy' | 'error' | 'worktreePath' | 'branch' | 'sessionId' | 'finishReason') =>
        text(raw[key]) ? { [key]: text(raw[key]) } : {};
    const optionalTime = (key: 'retryAt' | 'startedAt' | 'finishedAt') => (time(raw[key]) !== undefined ? { [key]: time(raw[key]) } : {});
    return {
        id,
        connectionId,
        pluginId,
        task,
        repoPath,
        ...optionalText('agentId'),
        ...optionalText('addedBy'),
        status,
        addedAt,
        updatedAt: time(raw.updatedAt) ?? addedAt,
        attempts: clamp(raw.attempts, 0, MAX_START_ATTEMPTS, 0),
        ...optionalText('error'),
        ...optionalTime('retryAt'),
        ...optionalText('worktreePath'),
        ...optionalText('branch'),
        ...optionalText('sessionId'),
        ...optionalTime('startedAt'),
        ...optionalTime('finishedAt'),
        ...optionalText('finishReason')
    };
}

/** Checks a queue from the file or from the page. Items that are not valid go out. An item ID shows one time only. */
export function normalizeQueueState(value: unknown): QueueState {
    const raw = record(value);
    const seen = new Set<string>();
    const items: QueueItem[] = [];
    for (const entry of Array.isArray(raw.items) ? raw.items : []) {
        const item = normalizeItem(entry);
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
    }
    return pruneFinished({ items, settings: normalizeQueueSettings(raw.settings) });
}
