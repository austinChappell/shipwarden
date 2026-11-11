import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Automation, AutomationRun } from '@shared/automations';
import { AutomationStore } from './automation-store';

const automation: Automation = {
    version: 1,
    id: 'fix-ci',
    name: 'Fix CI',
    trigger: { type: 'ci.failed' },
    actions: [{ type: 'sendToAgent', prompt: 'Fix it' }],
    limits: { approval: 'auto', maxRunsPerTarget: 3, maxRunning: 2 },
    status: 'on',
    binding: { repos: ['/repo'] }
};

function run(id: string, key = 'ci:1'): AutomationRun {
    return {
        id,
        automationId: 'fix-ci',
        automationName: 'Fix CI',
        status: 'running',
        event: { trigger: 'ci.failed', key, target: 'pr:/repo#1', label: '#1', at: 1 },
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
}

describe('AutomationStore', () => {
    let root: string;
    let store: AutomationStore;
    let trashed: string[];

    beforeEach(async () => {
        root = await mkdtemp(path.join(os.tmpdir(), 'automations-'));
        trashed = [];
        store = new AutomationStore(path.join(root, 'automations'), path.join(root, 'runs.json'), async file => {
            trashed.push(file);
            await rm(file);
        });
    });

    afterEach(async () => {
        store.close();
        await rm(root, { recursive: true, force: true });
    });

    it('saves each automation as one file and lists it', async () => {
        await store.save(automation);
        const text = await readFile(path.join(root, 'automations', 'fix-ci.json'), 'utf8');
        expect(JSON.parse(text)).toMatchObject({ id: 'fix-ci', status: 'on', binding: { repos: ['/repo'] } });
        const list = await store.list();
        expect(list.automations.map(item => item.id)).toEqual(['fix-ci']);
        expect(list.problems).toEqual([]);
    });

    it('reports files that are not valid, and uses the file name as the ID', async () => {
        await mkdir(path.join(root, 'automations'), { recursive: true });
        await writeFile(path.join(root, 'automations', 'broken.json'), '{');
        await writeFile(path.join(root, 'automations', 'no-name.json'), JSON.stringify({ ...automation, name: '' }));
        await writeFile(path.join(root, 'automations', 'copy.json'), JSON.stringify(automation));
        const list = await store.list();
        expect(list.automations.map(item => item.id)).toEqual(['copy']);
        expect(list.problems.map(problem => problem.file)).toEqual(['broken.json', 'no-name.json']);
        expect(list.problems[0].error).toMatch(/not valid JSON/);
    });

    it('removes the old file when the ID changes, and moves a removed automation to the Trash', async () => {
        await store.save(automation);
        await store.save({ ...automation, id: 'fix-ci-2' }, 'fix-ci');
        expect((await store.list()).automations.map(item => item.id)).toEqual(['fix-ci-2']);
        await store.remove('fix-ci-2');
        expect(trashed).toEqual([path.join(root, 'automations', 'fix-ci-2.json')]);
        await expect(store.remove('../x')).resolves.toBeUndefined();
    });

    it('exports without the binding', async () => {
        await store.save(automation);
        const text = await store.exportText('fix-ci');
        expect(text).not.toContain('/repo');
    });

    it('claims an event one time only', async () => {
        expect(await store.claim(run('a'))).not.toBeNull();
        expect(await store.claim(run('b'))).toBeNull();
        expect(await store.claim(run('c', 'ci:2'))).not.toBeNull();
        const state = await store.runState();
        expect(state.runs.map(item => item.id)).toEqual(['c', 'a']);
    });

    it('updates a run, seeds keys and records schedule runs', async () => {
        await store.claim(run('a'));
        expect((await store.updateRun('a', { status: 'done', detail: 'ok' }))?.status).toBe('done');
        await store.seed('fix-ci', ['ci:9']);
        expect(await store.claim(run('x', 'ci:9'))).toBeNull();
        await store.setScheduleRun('daily', 42);
        const state = await store.runState();
        expect(state.seeded).toEqual(['fix-ci']);
        expect(state.scheduleRuns).toEqual({ daily: 42 });
        await store.clearHistory();
        expect((await store.runState()).runs).toEqual([]);
    });
});
