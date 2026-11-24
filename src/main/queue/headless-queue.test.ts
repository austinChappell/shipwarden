import { mkdtemp, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addToQueue, changeQueueSettings, EMPTY_QUEUE, START_GRACE_MS, type QueueItem, type QueueState } from '@shared/task-queue';
import type { Task } from '@shared/tasks';
import type { TerminalSession } from '@shared/terminal';
import { HeadlessQueue } from './headless-queue';
import { QueueStore } from './queue-store';

const NOW = 1_700_000_000_000;

function task(id: string): Task {
    return { id, key: id.toUpperCase(), title: `Task ${id}`, status: { id: 'open', name: 'Open', category: 'todo' }, description: `Do ${id}.` };
}

function queueOf(ids: string[], maxRunning: number, finishWhen: 'idle' | 'pullRequest' = 'idle'): QueueState {
    let state = changeQueueSettings(EMPTY_QUEUE, { maxRunning, finishWhen, idleMinutes: 1 });
    for (const [index, id] of ids.entries()) {
        state = addToQueue(state, { connectionId: 'c1', pluginId: 'local', task: task(id), repoPath: '/repo' }, id, NOW + index).state;
    }
    return state;
}

let folder: string;
let store: QueueStore;
let now: number;
let sessions: TerminalSession[];
let started: string[];
let fail: Set<string>;
let queue: HeadlessQueue;

beforeEach(async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), 'headless-queue-'));
    store = new QueueStore(path.join(folder, 'task-queue.json'));
    now = NOW;
    sessions = [];
    started = [];
    fail = new Set();
    queue = new HeadlessQueue({
        store,
        sessions: async () => sessions,
        summaries: () => ({}),
        startTask: async (item: QueueItem) => {
            if (fail.has(item.id)) throw new Error('git refused the branch.');
            started.push(item.id);
            const session: TerminalSession = {
                id: `s-${item.id}`,
                title: 'Claude Code',
                cwd: `/wt/${item.id}`,
                worktreePath: `/wt/${item.id}`,
                isAgent: true,
                cols: 120,
                rows: 32,
                exited: false,
                lastActiveAt: now,
                agentState: 'working'
            };
            sessions.push(session);
            return { worktree: { path: `/wt/${item.id}`, branch: item.id }, session };
        },
        now: () => now
    });
});

afterEach(async () => {
    await queue.stop();
    await rm(folder, { recursive: true, force: true });
});

describe('HeadlessQueue', () => {
    it('starts the queued items up to the limit and saves the state', async () => {
        await store.save(queueOf(['a', 'b', 'c'], 2));
        await queue.start();
        await queue.tick();
        expect(started).toEqual(['a', 'b']);
        const saved = await new QueueStore(path.join(folder, 'task-queue.json')).get();
        expect(saved.items.map(item => item.status)).toEqual(['running', 'running', 'queued']);
        expect(saved.items[0]).toMatchObject({ worktreePath: '/wt/a', branch: 'a', sessionId: 's-a' });
    });

    it('starts the next item when an agent was idle for the idle time', async () => {
        await store.save(queueOf(['a', 'b'], 1));
        await queue.start();
        await queue.tick();
        expect(started).toEqual(['a']);
        sessions[0] = { ...sessions[0], agentState: 'idle', agentStateAt: now };
        now += 61_000;
        await queue.tick();
        expect(started).toEqual(['a', 'b']);
        const state = await store.get();
        expect(state.items.find(item => item.id === 'a')).toMatchObject({ status: 'done', finishReason: 'The agent was idle for 1 minute.' });
    });

    it('does not count a missing agent as exited just after its start', async () => {
        let state = queueOf(['a', 'b'], 1);
        state = {
            ...state,
            items: state.items.map(item => (item.id === 'a' ? { ...item, status: 'running', sessionId: 'gone', startedAt: NOW - 10 * START_GRACE_MS } : item))
        };
        await store.save(state);
        await queue.start();
        await queue.tick();
        expect(started).toEqual([]);
        now += START_GRACE_MS;
        await queue.tick();
        expect(started).toEqual(['b']);
    });

    it('records a failed start and keeps the item for a retry', async () => {
        fail.add('a');
        await store.save(queueOf(['a'], 1));
        await queue.start();
        await queue.tick();
        const [item] = (await store.get()).items;
        expect(item).toMatchObject({ status: 'queued', attempts: 1, error: 'git refused the branch.' });
    });

    it('puts a start that did not end back in the queue', async () => {
        let state = queueOf(['a'], 1);
        state = { ...state, items: state.items.map(item => ({ ...item, status: 'starting' })) };
        await store.save(state);
        fail.add('a');
        await queue.start();
        const [item] = (await store.get()).items;
        expect(item).toMatchObject({ status: 'queued', error: 'ShipWarden stopped during the start.' });
    });

    it('lists the repositories of running items in the pull request mode', async () => {
        await store.save(queueOf(['a', 'b'], 1, 'pullRequest'));
        await queue.start();
        expect(await queue.reposToWatch()).toEqual([]);
        await queue.tick();
        expect(await queue.reposToWatch()).toEqual(['/repo']);
    });
});
