import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newCompareGroup, type CompareTask } from '@shared/agent-compare';
import { CompareStore } from './compare-store';

const task: CompareTask = { connectionId: 'c1', pluginId: 'local', taskId: 't1', title: 'Fix the login' };

describe('CompareStore', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-compare-'));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('saves, replaces, lists, and removes the comparisons, the newest change first', async () => {
        const file = path.join(dir, 'agent-compare.json');
        const store = new CompareStore(file);
        const run = { agentId: 'claude', agentName: 'Claude Code', branch: 'fix-claude', worktreePath: '/w/a' };
        const first = newCompareGroup('/repo', task, [run], 100);
        const second = newCompareGroup('/repo', task, [{ ...run, worktreePath: '/w/b' }], 200);
        await store.save(first);
        await store.save(second);
        await store.save({ ...first, keptPath: '/w/a', updatedAt: 300 });
        const listed = await new CompareStore(file).list();
        expect(listed.map(group => group.id)).toEqual([first.id, second.id]);
        expect(listed[0].keptPath).toBe('/w/a');
        await store.remove(first.id);
        expect((await store.list()).map(group => group.id)).toEqual([second.id]);
    });

    it('refuses a comparison that is not valid', async () => {
        await expect(new CompareStore(path.join(dir, 'agent-compare.json')).save({ id: 'x' })).rejects.toThrow(/not valid/);
    });
});
