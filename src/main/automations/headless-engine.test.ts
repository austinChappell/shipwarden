import { mkdtemp, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WAIT_FOR_APP_PREFIX } from '@shared/automation-engine';
import { DEFAULT_AUTOMATION_SETTINGS, type Automation, type AutomationSettings } from '@shared/automations';
import type { BranchSummary } from '@shared/github';
import type { TerminalSession } from '@shared/terminal';
import { AutomationStore } from './automation-store';
import { HeadlessEngine, sessionBusy, type HeadlessAgents } from './headless-engine';

/** Monday 23 Nov 2026, 09:05 local time. */
const MONDAY_0905 = new Date(2026, 10, 23, 9, 5).getTime();

function automation(change: Partial<Automation> & Pick<Automation, 'id' | 'trigger' | 'actions'>): Automation {
    return {
        version: 1,
        name: change.id,
        limits: { approval: 'auto', maxRunsPerTarget: 3, maxRunning: 2 },
        status: 'on',
        binding: { repos: ['/repo'] },
        ...change
    };
}

function session(change: Partial<TerminalSession> = {}): TerminalSession {
    return {
        id: 's1',
        title: 'Claude Code',
        cwd: '/repo-wt',
        worktreePath: '/repo-wt',
        isAgent: true,
        cols: 120,
        rows: 32,
        exited: false,
        lastActiveAt: 0,
        ...change
    };
}

function summary(checks: string): BranchSummary {
    return { number: 7, title: 'Fix login', url: 'https://github.com/o/r/pull/7', headSha: 'abc', isDraft: false, reviewDecision: null, checks };
}

let folder: string;
let store: AutomationStore;
let now: number;
let settings: AutomationSettings;
let sessions: TerminalSession[];
let agents: HeadlessAgents & { started: unknown[]; prompts: unknown[] };
let notes: string[];
let engine: HeadlessEngine;

beforeEach(async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), 'headless-engine-'));
    store = new AutomationStore(path.join(folder, 'automations'), path.join(folder, 'runs.json'), async () => undefined);
    now = MONDAY_0905;
    settings = { ...DEFAULT_AUTOMATION_SETTINGS };
    sessions = [];
    notes = [];
    const started: unknown[] = [];
    const prompts: unknown[] = [];
    agents = {
        started,
        prompts,
        sessions: async () => sessions,
        startInNewWorktree: async (repoPath, branch, prompt, agentId) => {
            started.push({ repoPath, branch, prompt, agentId });
            const created = session({ id: 'new', worktreePath: `/wt/${branch}` });
            sessions.push(created);
            return { worktree: { path: `/wt/${branch}`, branch }, session: created };
        },
        promptAgent: async (worktreePath, prompt, target) => {
            prompts.push({ worktreePath, prompt, target });
            return session({ worktreePath });
        }
    };
    engine = new HeadlessEngine({
        store,
        settings: async () => settings,
        places: async () => [{ repo: '/repo', worktree: { path: '/repo-wt', branch: 'fix-login', isMain: false } }],
        agents,
        http: async () => ({ status: 200, statusText: 'OK', body: '{"ok":true}', truncated: false }),
        notify: (title, body) => notes.push(`${title}: ${body}`),
        now: () => now
    });
});

afterEach(async () => {
    await engine.stop();
    await rm(folder, { recursive: true, force: true });
});

describe('HeadlessEngine schedules', () => {
    it('starts an agent at the schedule time, one time only', async () => {
        await store.save(
            automation({
                id: 'nightly',
                trigger: { type: 'schedule', days: [0, 1, 2, 3, 4, 5, 6], time: '09:10' },
                actions: [{ type: 'startAgent', prompt: 'Update the deps on {{branch}}', branch: 'deps-{{date}}' }]
            })
        );
        await engine.start();
        await engine.tick();
        expect(agents.started).toHaveLength(0);
        now += 6 * 60_000;
        await engine.tick();
        await engine.tick();
        expect(agents.started).toEqual([{ repoPath: '/repo', branch: 'deps-2026-11-23', prompt: 'Update the deps on deps-2026-11-23', agentId: undefined }]);
        const [run] = (await store.runState()).runs;
        expect(run.status).toBe('done');
        expect(run.sessionId).toBe('new');
        expect(run.detail).toContain('Started Claude Code in a new worktree on deps-2026-11-23.');
    });

    it('does not run a schedule time from before its start', async () => {
        await store.save(
            automation({
                id: 'nightly',
                trigger: { type: 'schedule', days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' },
                actions: [{ type: 'notify', title: 'Hello' }]
            })
        );
        await engine.start();
        await engine.tick();
        expect((await store.runState()).runs).toEqual([]);
    });

    it('records nothing while the automations are paused', async () => {
        settings = { ...settings, paused: true };
        await store.save(automation({ id: 'nightly', trigger: { type: 'schedule', days: [1], time: '09:06' }, actions: [{ type: 'notify', title: 'Hello' }] }));
        await engine.start();
        now += 2 * 60_000;
        await engine.tick();
        expect((await store.runState()).runs).toEqual([]);
    });
});

describe('HeadlessEngine CI failures', () => {
    beforeEach(async () => {
        await store.save(automation({ id: 'fix-ci', trigger: { type: 'ci.failed' }, actions: [{ type: 'sendToAgent', prompt: 'CI failed on {{pr.url}}' }] }));
        await engine.start();
    });

    it('sends a prompt when the checks go from pending to a failure', async () => {
        await engine.onSummaries({ '/repo': { 'fix-login': summary('PENDING') } });
        expect(agents.prompts).toHaveLength(0);
        await engine.onSummaries({ '/repo': { 'fix-login': summary('FAILURE') } });
        expect(agents.prompts).toEqual([{ worktreePath: '/repo-wt', prompt: 'CI failed on https://github.com/o/r/pull/7', target: { repoPath: '/repo' } }]);
        expect((await store.runState()).runs[0].status).toBe('done');
    });

    it('holds the run while the agent of the worktree is busy, and runs it later', async () => {
        sessions = [session({ agentState: 'working' })];
        await engine.onSummaries({ '/repo': { 'fix-login': summary('PENDING') } });
        await engine.onSummaries({ '/repo': { 'fix-login': summary('FAILURE') } });
        let [run] = (await store.runState()).runs;
        expect(run.status).toBe('held');
        expect(run.detail).toBe('Waiting for the agent to finish its turn.');
        sessions = [session({ agentState: 'done' })];
        await engine.tick();
        [run] = (await store.runState()).runs;
        expect(run.status).toBe('done');
        expect(agents.prompts).toHaveLength(1);
    });

    it('waits for approval, and runs after an approval from the phone', async () => {
        await store.save(
            automation({
                id: 'fix-ci',
                trigger: { type: 'ci.failed' },
                actions: [{ type: 'sendToAgent', prompt: 'Fix it' }],
                limits: { approval: 'ask', maxRunsPerTarget: 3, maxRunning: 2 }
            })
        );
        await engine.onSummaries({ '/repo': { 'fix-login': summary('PENDING') } });
        await engine.onSummaries({ '/repo': { 'fix-login': summary('ERROR') } });
        const [pending] = (await store.runState()).runs;
        expect(pending.status).toBe('pending');
        expect(notes).toEqual(['fix-ci is waiting for your approval: #7 Fix login']);
        expect(await engine.approve(pending.id)).toBe(true);
        await engine.stop();
        expect((await store.runState()).runs[0].status).toBe('done');
        expect(await engine.approve(pending.id)).toBe(false);
    });

    it('skips a pending run', async () => {
        await store.save(
            automation({
                id: 'fix-ci',
                trigger: { type: 'ci.failed' },
                actions: [{ type: 'sendToAgent', prompt: 'Fix it' }],
                limits: { approval: 'ask', maxRunsPerTarget: 3, maxRunning: 2 }
            })
        );
        await engine.onSummaries({ '/repo': { 'fix-login': summary('PENDING') } });
        await engine.onSummaries({ '/repo': { 'fix-login': summary('FAILURE') } });
        const [pending] = (await store.runState()).runs;
        expect(await engine.skip(pending.id)).toBe(true);
        expect((await store.runState()).runs[0]).toMatchObject({ status: 'skipped', detail: 'You skipped the run.' });
        expect(agents.prompts).toHaveLength(0);
    });

    it('gives a run with an action that needs the app to the app', async () => {
        await store.save(
            automation({
                id: 'fix-ci',
                trigger: { type: 'ci.failed' },
                actions: [
                    { type: 'http', method: 'POST', url: 'https://example.com' },
                    { type: 'runHeadless', prompt: 'Why?' }
                ]
            })
        );
        await engine.onSummaries({ '/repo': { 'fix-login': summary('PENDING') } });
        await engine.onSummaries({ '/repo': { 'fix-login': summary('FAILURE') } });
        const [run] = (await store.runState()).runs;
        expect(run.status).toBe('held');
        expect(run.detail?.startsWith(WAIT_FOR_APP_PREFIX)).toBe(true);
        expect(run.detail).toContain('"Ask an agent"');
        // The tick does not try it again. The app runs it when it opens.
        await engine.tick();
        expect((await store.runState()).runs[0].updatedAt).toBe(run.updatedAt);
    });

    it('gives a run that uses the task variables to the app', async () => {
        await store.save(automation({ id: 'fix-ci', trigger: { type: 'ci.failed' }, actions: [{ type: 'sendToAgent', prompt: 'Fix {{task.title}}' }] }));
        await engine.onSummaries({ '/repo': { 'fix-login': summary('PENDING') } });
        await engine.onSummaries({ '/repo': { 'fix-login': summary('FAILURE') } });
        expect((await store.runState()).runs[0].detail).toContain('the task variables');
        expect(agents.prompts).toHaveLength(0);
    });

    it('records a failed action with its error and shows a notification', async () => {
        agents.promptAgent = async () => {
            throw new Error('The agent tab closed.');
        };
        await engine.onSummaries({ '/repo': { 'fix-login': summary('PENDING') } });
        await engine.onSummaries({ '/repo': { 'fix-login': summary('FAILURE') } });
        expect((await store.runState()).runs[0]).toMatchObject({ status: 'failed', detail: 'The agent tab closed.' });
        expect(notes).toEqual(['fix-ci failed: The agent tab closed.']);
    });
});

describe('HeadlessEngine start', () => {
    it('fails a run that was running when the last owner stopped', async () => {
        await store.claim({
            id: 'r1',
            automationId: 'a',
            automationName: 'A',
            status: 'running',
            event: { trigger: 'schedule', key: 'k', target: 't', label: 'l', at: 1 },
            createdAt: 1,
            updatedAt: 1
        });
        await engine.start();
        expect((await store.runState()).runs[0]).toMatchObject({ status: 'failed', detail: 'ShipWarden stopped during the run.' });
    });

    it('runs an HTTP action and keeps the secret out of the history', async () => {
        const http = vi.fn(async () => ({ status: 201, statusText: 'Created', body: '', truncated: false }));
        engine = new HeadlessEngine({
            store,
            settings: async () => settings,
            places: async () => [],
            agents,
            http,
            notify: () => undefined,
            now: () => now
        });
        await store.save(
            automation({
                id: 'ping',
                trigger: { type: 'schedule', days: [1], time: '09:06' },
                actions: [{ type: 'http', method: 'POST', url: 'https://example.com/{{secret.KEY}}' }],
                binding: { secrets: { KEY: 'hidden' } }
            })
        );
        await engine.start();
        now += 2 * 60_000;
        await engine.tick();
        expect(http).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com/hidden' }));
        const [run] = (await store.runState()).runs;
        expect(run.status).toBe('done');
        expect(run.detail).not.toContain('hidden');
    });
});

describe('sessionBusy', () => {
    it('uses the hook state, else the time of the last output', () => {
        expect(sessionBusy(session({ agentState: 'working' }), 100_000)).toBe(true);
        expect(sessionBusy(session({ agentState: 'idle' }), 100_000)).toBe(false);
        expect(sessionBusy(session({ lastActiveAt: 95_000 }), 100_000)).toBe(true);
        expect(sessionBusy(session({ lastActiveAt: 80_000 }), 100_000)).toBe(false);
    });
});
