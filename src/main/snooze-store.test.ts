import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SNOOZE_KEEP_MS, type Snooze } from '@shared/snooze';
import { SnoozeStore } from './snooze-store';

describe('SnoozeStore', () => {
    let dir: string;
    let file: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-snoozes-'));
        file = path.join(dir, 'snoozes.json');
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('keeps the snoozes in the file', async () => {
        await new SnoozeStore(file).set('pr:a', { at: 1, until: 1000 }, 10);
        await new SnoozeStore(file).set('pr:b', { at: 1, activity: { head: 'x' } }, 10);
        expect(await new SnoozeStore(file).list(10)).toEqual({ 'pr:a': { at: 1, until: 1000 }, 'pr:b': { at: 1, activity: { head: 'x' } } });
    });

    it('removes a snooze', async () => {
        const store = new SnoozeStore(file);
        await store.set('pr:a', { at: 1, until: 1000 }, 10);
        await store.set('pr:a', null, 10);
        expect(await store.list(10)).toEqual({});
    });

    it('does not list or keep the snoozes that ended', async () => {
        const store = new SnoozeStore(file);
        await store.set('pr:a', { at: 1, until: 100 }, 10);
        await store.set('pr:b', { at: 1, activity: {} }, 10);
        expect(Object.keys(await store.list(100))).toEqual(['pr:b']);
        await store.set('pr:c', { at: 200, until: 300 }, SNOOZE_KEEP_MS + 2);
        expect(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).snoozes)).toEqual(['pr:c']);
    });

    it('ignores bad data', async () => {
        const store = new SnoozeStore(file);
        await store.set('pr:a', { at: 1 } as Snooze, 10);
        await store.set('', { at: 1, until: 100 }, 10);
        expect(await store.list(10)).toEqual({});
    });
});
