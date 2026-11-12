import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newGroup } from '@shared/pr-groups';
import { PrGroupStore } from './pr-group-store';

describe('PrGroupStore', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-groups-'));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('saves, replaces, lists and removes the groups, the newest change first', async () => {
        const file = path.join(dir, 'pr-groups.json');
        const store = new PrGroupStore(file);
        const first = newGroup(100, 'First');
        const second = newGroup(200, 'Second');
        await store.save(first);
        await store.save(second);
        await store.save({ ...first, name: 'First again', updatedAt: 300 });
        expect((await new PrGroupStore(file).list()).map(group => group.name)).toEqual(['First again', 'Second']);
        await store.remove(first.id);
        expect((await store.list()).map(group => group.name)).toEqual(['Second']);
    });

    it('refuses a group that is not valid', async () => {
        await expect(new PrGroupStore(path.join(dir, 'pr-groups.json')).save({ name: 'No ID' })).rejects.toThrow(/not valid/);
    });
});
