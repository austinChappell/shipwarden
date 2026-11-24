import { existsSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings';
import { AutomationStore } from '../automations/automation-store';
import { EngineLock, engineLockPath } from '../automations/engine-lock';
import type { HelperAgents } from './headless-agents';
import { HelperAutomations } from './helper-automations';

let folder: string;
let settings: AppSettings;
let automations: HelperAutomations;

async function until(test: () => boolean | Promise<boolean>): Promise<void> {
    const end = Date.now() + 3000;
    while (!(await test())) {
        if (Date.now() > end) throw new Error('The condition did not come true in time.');
        await new Promise(done => setTimeout(done, 20));
    }
}

beforeEach(async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), 'helper-automations-'));
    settings = { ...DEFAULT_SETTINGS, automations: { ...DEFAULT_SETTINGS.automations, runWhenClosed: true } };
    automations = new HelperAutomations({
        userData: folder,
        automationsFolder: path.join(folder, 'automations'),
        settings: async () => settings,
        places: async () => [],
        agents: { sessions: async () => [] } as unknown as HelperAgents,
        github: { branchSummaries: async () => ({}), checks: async () => [], saveJobLog: async () => '' },
        http: async () => ({ status: 200, statusText: 'OK', body: '', truncated: false }),
        notify: () => undefined,
        log: () => undefined
    });
});

afterEach(async () => {
    await automations.stop();
    await rm(folder, { recursive: true, force: true });
});

describe('HelperAutomations', () => {
    it('takes the lock when the setting is on, answers a pending run, and releases the lock at the stop', async () => {
        const store = new AutomationStore(path.join(folder, 'automations'), path.join(folder, 'automation-runs.json'), async () => undefined);
        await store.claim({
            id: 'r1',
            automationId: 'gone',
            automationName: 'Gone',
            status: 'pending',
            event: { trigger: 'schedule', key: 'k', target: 't', label: 'l', at: 1 },
            createdAt: Date.now(),
            updatedAt: Date.now()
        });
        automations.start();
        await until(() => automations.owns);
        expect(existsSync(engineLockPath(folder))).toBe(true);
        expect(await automations.answerRun('r1', false)).toBe(true);
        await expect(automations.answerRun('r1', true)).rejects.toThrow('not waiting for approval');
        await automations.stop();
        expect(automations.owns).toBe(false);
        expect(existsSync(engineLockPath(folder))).toBe(false);
        const runs = await new AutomationStore(path.join(folder, 'automations'), path.join(folder, 'automation-runs.json'), async () => undefined).runState();
        expect(runs.runs[0]).toMatchObject({ status: 'skipped' });
    });

    it('does not take the lock while the app holds it, and does not answer runs then', async () => {
        const app = new EngineLock({ file: engineLockPath(folder), owner: 'app' });
        expect(await app.tryAcquire()).toBe(true);
        automations.start();
        await new Promise(done => setTimeout(done, 100));
        expect(automations.owns).toBe(false);
        expect(await automations.answerRun('r1', true)).toBe(false);
        await app.release();
    });

    it('does not take the lock when the setting is off', async () => {
        settings = DEFAULT_SETTINGS;
        automations.start();
        await new Promise(done => setTimeout(done, 100));
        expect(automations.owns).toBe(false);
        expect(existsSync(engineLockPath(folder))).toBe(false);
    });
});
