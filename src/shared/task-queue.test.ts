import { describe, expect, it } from 'vitest';
import type { Task } from './tasks';
import { budgetBlock, budgetWaitText, type ProviderUsage } from './usage';
import {
    activeCount,
    addToQueue,
    changeQueueSettings,
    clearFinished,
    EMPTY_QUEUE,
    finishReason,
    markFinished,
    markStarted,
    markStartFailed,
    markStarting,
    MAX_START_ATTEMPTS,
    moveInQueue,
    nextStarts,
    normalizeQueueState,
    queuedItems,
    queuePosition,
    recoverQueue,
    removeFromQueue,
    retryItem,
    RETRY_DELAY_MS,
    START_GRACE_MS,
    type AgentObservation,
    type QueueState
} from './task-queue';

const NOW = 1_700_000_000_000;

function task(id: string): Task {
    return { id, key: id.toUpperCase(), title: `Task ${id}`, status: { id: 'open', name: 'Open', category: 'todo' }, description: `Do ${id}.` };
}

/** A queue with the tasks in this order. */
function queueOf(ids: string[], maxRunning = 2): QueueState {
    let state = changeQueueSettings(EMPTY_QUEUE, { maxRunning });
    for (const [index, id] of ids.entries()) {
        state = addToQueue(state, { connectionId: 'c1', pluginId: 'local', task: task(id), repoPath: '/repo' }, id, NOW + index).state;
    }
    return state;
}

/** Starts the items as the runner does: "starting", then "running". */
function startAll(state: QueueState, ids: string[], now = NOW): QueueState {
    let next = state;
    for (const id of ids) {
        next = markStarting(next, id, now);
        next = markStarted(next, id, { worktreePath: `/wt/${id}`, branch: id, sessionId: `s-${id}` }, now);
    }
    return next;
}

const ids = (state: QueueState) => state.items.map(item => item.id);
const startIds = (state: QueueState, now = NOW) => nextStarts(state, now).items.map(item => item.id);

describe('addToQueue', () => {
    it('adds the task to the end and keeps a copy of the task', () => {
        const state = queueOf(['a', 'b']);
        expect(ids(state)).toEqual(['a', 'b']);
        expect(state.items[0]).toMatchObject({ status: 'queued', attempts: 0, repoPath: '/repo', task: { id: 'a', key: 'A', description: 'Do a.' } });
    });

    it('does not add a task that is in the queue', () => {
        const state = queueOf(['a']);
        const result = addToQueue(state, { connectionId: 'c1', pluginId: 'local', task: task('a'), repoPath: '/repo' }, 'other', NOW);
        expect(result.added).toBe(false);
        expect(result.item.id).toBe('a');
        expect(result.state).toBe(state);
    });

    it('adds a task again after it finished', () => {
        const state = markFinished(startAll(queueOf(['a']), ['a']), 'a', 'Done.', NOW);
        const result = addToQueue(state, { connectionId: 'c1', pluginId: 'local', task: task('a'), repoPath: '/repo' }, 'a2', NOW);
        expect(result.added).toBe(true);
        expect(ids(result.state)).toEqual(['a', 'a2']);
    });
});

describe('the limit', () => {
    it('starts at most maxRunning items', () => {
        expect(startIds(queueOf(['a', 'b', 'c', 'd'], 2))).toEqual(['a', 'b']);
        expect(startIds(queueOf(['a', 'b', 'c', 'd'], 3))).toEqual(['a', 'b', 'c']);
    });

    it('counts the starting and running items as used places', () => {
        let state = queueOf(['a', 'b', 'c'], 2);
        state = markStarting(state, 'a', NOW);
        expect(activeCount(state)).toBe(1);
        expect(startIds(state)).toEqual(['b']);
        state = startAll(state, ['b']);
        expect(startIds(state)).toEqual([]);
    });

    it('starts the next item when an agent finishes', () => {
        let state = startAll(queueOf(['a', 'b', 'c'], 2), ['a', 'b']);
        expect(startIds(state)).toEqual([]);
        state = markFinished(state, 'a', 'The agent opened a pull request.', NOW);
        expect(startIds(state)).toEqual(['c']);
    });

    it('starts nothing while the queue is paused', () => {
        const state = changeQueueSettings(queueOf(['a', 'b']), { paused: true });
        expect(startIds(state)).toEqual([]);
    });

    it('keeps the limit in its range', () => {
        expect(changeQueueSettings(EMPTY_QUEUE, { maxRunning: 0 }).settings.maxRunning).toBe(1);
        expect(changeQueueSettings(EMPTY_QUEUE, { maxRunning: 99 }).settings.maxRunning).toBe(20);
        expect(changeQueueSettings(EMPTY_QUEUE, { maxRunning: 2.6 }).settings.maxRunning).toBe(3);
    });
});

describe('the order', () => {
    it('starts the items in the order of the queue', () => {
        const state = moveInQueue(queueOf(['a', 'b', 'c'], 1), 'c', 0);
        expect(queuedItems(state).map(item => item.id)).toEqual(['c', 'a', 'b']);
        expect(startIds(state)).toEqual(['c']);
        expect(queuePosition(state, 'b')).toBe(3);
    });

    it('moves the queued items only, and the other items keep their place', () => {
        let state = startAll(queueOf(['a', 'b', 'c', 'd'], 1), ['b']);
        state = moveInQueue(state, 'd', 0);
        expect(ids(state)).toEqual(['d', 'b', 'a', 'c']);
        expect(state.items[1].status).toBe('running');
    });

    it('ignores a move of an item that is not queued, or out of the range', () => {
        const state = startAll(queueOf(['a', 'b']), ['a']);
        expect(moveInQueue(state, 'a', 1)).toBe(state);
        expect(moveInQueue(state, 'b', 5)).toBe(state);
    });

    it('removes an item', () => {
        expect(ids(removeFromQueue(queueOf(['a', 'b', 'c']), 'b'))).toEqual(['a', 'c']);
    });
});

describe('a failure', () => {
    it('puts a failed start at the end of the queue with its error', () => {
        let state = markStarting(queueOf(['a', 'b', 'c'], 1), 'a', NOW);
        state = markStartFailed(state, 'a', 'The branch exists.', NOW);
        expect(queuedItems(state).map(item => item.id)).toEqual(['b', 'c', 'a']);
        expect(state.items.find(item => item.id === 'a')).toMatchObject({ status: 'queued', attempts: 1, error: 'The branch exists.' });
        expect(startIds(state)).toEqual(['b']);
    });

    it('waits before it starts a failed item again, and other items go first', () => {
        let state = markStartFailed(markStarting(queueOf(['a', 'b'], 2), 'a', NOW), 'a', 'Error', NOW);
        expect(startIds(state)).toEqual(['b']);
        state = startAll(state, ['b']);
        state = markFinished(state, 'b', 'Done.', NOW);
        expect(startIds(state, NOW + 1000)).toEqual([]);
        expect(startIds(state, NOW + RETRY_DELAY_MS)).toEqual(['a']);
    });

    it(`stops an item after ${MAX_START_ATTEMPTS} failed starts`, () => {
        let state = queueOf(['a'], 1);
        for (let attempt = 0; attempt < MAX_START_ATTEMPTS; attempt++) {
            state = markStartFailed(markStarting(state, 'a', NOW), 'a', `Error ${attempt}`, NOW);
        }
        expect(state.items[0]).toMatchObject({ status: 'failed', attempts: MAX_START_ATTEMPTS, error: 'Error 2' });
        expect(startIds(state, NOW + RETRY_DELAY_MS * 10)).toEqual([]);
    });

    it('puts a failed item back in the queue with "Try again"', () => {
        let state = queueOf(['a', 'b'], 1);
        for (let attempt = 0; attempt < MAX_START_ATTEMPTS; attempt++) {
            state = markStartFailed(markStarting(state, 'a', NOW), 'a', 'Error', NOW);
        }
        state = retryItem(state, 'a', NOW);
        expect(queuedItems(state).map(item => item.id)).toEqual(['b', 'a']);
        expect(state.items.find(item => item.id === 'a')).toMatchObject({ status: 'queued', attempts: 0 });
        expect(state.items.find(item => item.id === 'a')?.error).toBeUndefined();
    });

    it('clears the finished and the failed items', () => {
        let state = startAll(queueOf(['a', 'b', 'c'], 3), ['a', 'b']);
        state = markFinished(state, 'a', 'Done.', NOW);
        expect(ids(clearFinished(state))).toEqual(['b', 'c']);
    });
});

describe('the start check', () => {
    it('stops the round at the first item that must wait', () => {
        const state = queueOf(['a', 'b', 'c'], 3);
        const plan = nextStarts(state, NOW, item => (item.id === 'b' ? 'Waiting for usage to reset' : undefined));
        expect(plan.items.map(item => item.id)).toEqual(['a']);
        expect(plan.waiting).toBe('Waiting for usage to reset');
    });

    it('keeps the items queued while the usage budget stops them, and starts them after the reset', () => {
        const state = queueOf(['a', 'b'], 2);
        const resetsAt = new Date(NOW + 3600_000).toISOString();
        const usage: ProviderUsage[] = [{ provider: 'claude', status: 'ok', windows: [{ kind: 'session', label: '5h', usedPercent: 90, resetsAt }] }];
        const check = (now: number) => {
            const block = budgetBlock(usage, { percent: 80, windows: 'all' }, 'claude', now);
            return block && budgetWaitText(block);
        };
        const waiting = nextStarts(state, NOW, (_item, _state, now) => check(now));
        expect(waiting.items).toEqual([]);
        expect(waiting.waiting?.startsWith('Waiting for usage to reset.')).toBe(true);
        expect(queuedItems(state).map(item => item.id)).toEqual(['a', 'b']);
        // The reset time passed. The old usage does not stop the queue.
        const later = nextStarts(state, NOW + 2 * 3600_000, (_item, _state, now) => check(now));
        expect(later.items.map(item => item.id)).toEqual(['a', 'b']);
    });

    it('does not run the check when no place is free', () => {
        const state = startAll(queueOf(['a', 'b'], 1), ['a']);
        let calls = 0;
        nextStarts(state, NOW, () => {
            calls++;
            return undefined;
        });
        expect(calls).toBe(0);
    });
});

describe('finishReason', () => {
    const running = startAll(queueOf(['a']), ['a']).items[0];
    const alive: AgentObservation = { alive: true, busy: false, quietSince: NOW, hasPullRequest: false };

    it('finishes an agent that opened a pull request', () => {
        const settings = { ...EMPTY_QUEUE.settings, finishWhen: 'pullRequest' as const };
        expect(finishReason(running, { ...alive, hasPullRequest: true }, settings, NOW)).toBe('The agent opened a pull request.');
        expect(finishReason(running, { ...alive, quietSince: NOW - 10 * 3600_000 }, settings, NOW)).toBeUndefined();
    });

    it('finishes an idle agent after the set time', () => {
        const settings = { ...EMPTY_QUEUE.settings, finishWhen: 'idle' as const, idleMinutes: 15 };
        expect(finishReason(running, { ...alive, quietSince: NOW - 14 * 60_000 }, settings, NOW)).toBeUndefined();
        expect(finishReason(running, { ...alive, quietSince: NOW - 15 * 60_000 }, settings, NOW)).toBe('The agent was idle for 15 minutes.');
        expect(finishReason(running, { ...alive, busy: true, quietSince: NOW - 60 * 60_000 }, settings, NOW)).toBeUndefined();
        expect(finishReason(running, { ...alive, quietSince: undefined }, settings, NOW)).toBeUndefined();
    });

    it('finishes an agent that exited, after the grace time of a new session', () => {
        const settings = EMPTY_QUEUE.settings;
        const gone = { ...alive, alive: false };
        expect(finishReason(running, gone, settings, NOW + 1000)).toBeUndefined();
        expect(finishReason(running, gone, settings, NOW + START_GRACE_MS)).toBe('The agent exited.');
    });

    it('does not finish an item that is not running', () => {
        const queued = queueOf(['a']).items[0];
        expect(finishReason(queued, { ...alive, alive: false }, EMPTY_QUEUE.settings, NOW + START_GRACE_MS)).toBeUndefined();
    });
});

describe('a restart of the app with a full queue', () => {
    it('reads the saved queue and continues with the same order and the same limit', () => {
        let state = queueOf(['a', 'b', 'c', 'd', 'e'], 2);
        state = moveInQueue(state, 'e', 0);
        state = startAll(state, ['e']);
        state = markStarting(state, 'a', NOW);
        // The app stops during the start of "a". The file has this JSON text.
        const file = JSON.parse(JSON.stringify(state));
        const read = recoverQueue(normalizeQueueState(file), NOW + 5000);

        // The running agent keeps its place. The start that did not end goes to the end, with an error.
        expect(read.items.find(item => item.id === 'e')).toMatchObject({ status: 'running', sessionId: 's-e', worktreePath: '/wt/e' });
        expect(read.items.find(item => item.id === 'a')).toMatchObject({ status: 'queued', attempts: 1, error: 'ShipWarden stopped during the start.' });
        expect(queuedItems(read).map(item => item.id)).toEqual(['b', 'c', 'd', 'a']);
        expect(read.settings.maxRunning).toBe(2);
        // One place is free, so the next item in the order starts.
        expect(startIds(read, NOW + 5000)).toEqual(['b']);
    });

    it('drops the items that are not valid, and the IDs that show twice', () => {
        const state = normalizeQueueState({
            items: [
                { id: 'x', connectionId: 'c1', pluginId: 'local', repoPath: '/repo', status: 'queued', addedAt: NOW, task: { id: 't', title: 'T' } },
                { id: 'x', connectionId: 'c1', pluginId: 'local', repoPath: '/repo', status: 'queued', addedAt: NOW, task: { id: 't2', title: 'T2' } },
                { id: 'y', connectionId: 'c1', pluginId: 'local', repoPath: '/repo', status: 'unknown', addedAt: NOW, task: { id: 't3', title: 'T3' } },
                { id: 'z', status: 'queued' },
                'text'
            ],
            settings: { maxRunning: 'three', finishWhen: 'idle', idleMinutes: 0 }
        });
        expect(ids(state)).toEqual(['x']);
        expect(state.items[0].task.status).toEqual({ id: '', name: '', category: 'todo' });
        expect(state.settings).toEqual({ maxRunning: 5, finishWhen: 'idle', idleMinutes: 1, paused: false });
    });

    it('reads an empty or broken file as an empty queue', () => {
        expect(normalizeQueueState(undefined)).toEqual(EMPTY_QUEUE);
        expect(normalizeQueueState({ items: 'no' })).toEqual(EMPTY_QUEUE);
    });
});
