import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addToQueue, changeQueueSettings, EMPTY_QUEUE } from '@shared/task-queue';
import { QueueStore } from './queue-store';

describe('QueueStore', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-queue-'));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('returns an empty queue when the file does not exist', async () => {
        expect(await new QueueStore(path.join(dir, 'task-queue.json')).get()).toEqual(EMPTY_QUEUE);
    });

    it('keeps the queue for the next start of the app', async () => {
        const file = path.join(dir, 'task-queue.json');
        const task = { id: 't1', title: 'Fix the login', status: { id: 'open', name: 'Open', category: 'todo' as const } };
        const state = addToQueue(
            changeQueueSettings(EMPTY_QUEUE, { maxRunning: 3 }),
            { connectionId: 'c1', pluginId: 'local', task, repoPath: '/repo' },
            'item-1',
            100
        ).state;
        await new QueueStore(file).save(state);
        const read = await new QueueStore(file).get();
        expect(read.settings.maxRunning).toBe(3);
        expect(read.items.map(item => item.id)).toEqual(['item-1']);
    });
});
