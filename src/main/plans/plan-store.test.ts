import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newPlan } from '@shared/plans';
import { PlanStore } from './plan-store';

describe('PlanStore', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-plans-'));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('saves, replaces and lists the plans, the newest change first', async () => {
        const file = path.join(dir, 'plans.json');
        const store = new PlanStore(file);
        const first = { ...newPlan('p1', 100), title: 'First' };
        const second = { ...newPlan('p1', 200), title: 'Second' };
        await store.save(first);
        await store.save(second);
        await store.save({ ...first, title: 'First again', updatedAt: 300 });
        const list = await new PlanStore(file).list();
        expect(list.map(plan => plan.title)).toEqual(['First again', 'Second']);
    });

    it('refuses a plan that is not valid', async () => {
        await expect(new PlanStore(path.join(dir, 'plans.json')).save({ title: 'No ID' })).rejects.toThrow(/not valid/);
    });

    it('removes a plan and the plans of a project', async () => {
        const store = new PlanStore(path.join(dir, 'plans.json'));
        const keep = newPlan('p1', 1);
        const gone = newPlan('p2', 2);
        const removed = newPlan('p1', 3);
        await Promise.all([keep, gone, removed].map(plan => store.save(plan)));
        await store.remove(removed.id);
        await store.removeProject('p2');
        expect((await store.list()).map(plan => plan.id)).toEqual([keep.id]);
    });
});
