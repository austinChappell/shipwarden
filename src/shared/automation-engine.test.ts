import { describe, expect, it } from 'vitest';
import {
    APPROVAL_DETAIL,
    appOnlyActions,
    checksVariable,
    decideRun,
    LIMIT_DETAIL,
    pendingRemoteRuns,
    runHttpAction,
    scheduleEvent,
    waitForAppDetail,
    WAIT_FOR_APP_PREFIX
} from './automation-engine';
import { DEFAULT_AUTOMATION_SETTINGS, EMPTY_RUN_STATE, type Automation, type AutomationEvent, type AutomationRun } from './automations';
import type { CheckRun } from './github';

const NOW = new Date(2026, 10, 23, 9, 0).getTime();

const automation: Automation = {
    version: 1,
    id: 'fix-ci',
    name: 'Fix CI',
    trigger: { type: 'ci.failed' },
    actions: [{ type: 'sendToAgent', prompt: 'Fix it' }],
    limits: { approval: 'auto', maxRunsPerTarget: 2, maxRunning: 2 },
    status: 'on',
    binding: {}
};

const event: AutomationEvent = { trigger: 'ci.failed', key: 'ci:/repo#7@abc', target: 'pr:/repo#7', label: '#7 Fix login', at: NOW, worktreePath: '/wt' };

const inputs = { settings: DEFAULT_AUTOMATION_SETTINGS, usage: [], now: NOW, id: () => 'run-1' };

function past(status: AutomationRun['status'], key: string, detail?: string): AutomationRun {
    return {
        id: key,
        automationId: 'fix-ci',
        automationName: 'Fix CI',
        status,
        event: { ...event, key },
        createdAt: NOW - 1000,
        updatedAt: NOW - 1000,
        ...(detail ? { detail } : {})
    };
}

describe('decideRun', () => {
    it('starts a run, or a pending run when the automation asks for approval', () => {
        expect(decideRun(automation, event, EMPTY_RUN_STATE, inputs)).toMatchObject({ id: 'run-1', status: 'running', worktreePath: '/wt' });
        const ask = { ...automation, limits: { ...automation.limits, approval: 'ask' as const } };
        expect(decideRun(ask, event, EMPTY_RUN_STATE, inputs)).toMatchObject({ status: 'pending', detail: APPROVAL_DETAIL });
    });

    it('records nothing for a fired event, a pause, or conditions that do not agree', () => {
        expect(decideRun(automation, event, { ...EMPTY_RUN_STATE, fired: { 'fix-ci|ci:/repo#7@abc': 1 } }, inputs)).toBeUndefined();
        expect(decideRun(automation, event, EMPTY_RUN_STATE, { ...inputs, settings: { ...inputs.settings, paused: true } })).toBeUndefined();
        const branch = { ...automation, conditions: { when: { var: 'branch', op: 'equals' as const, value: 'main' } } };
        expect(decideRun(branch, event, EMPTY_RUN_STATE, inputs)).toBeUndefined();
    });

    it('records the limit of runs one time for each target', () => {
        const runs = [past('done', 'a'), past('done', 'b')];
        expect(decideRun(automation, event, { ...EMPTY_RUN_STATE, runs }, inputs)).toMatchObject({ status: 'skipped', detail: LIMIT_DETAIL });
        expect(decideRun(automation, event, { ...EMPTY_RUN_STATE, runs: [...runs, past('skipped', 'c', LIMIT_DETAIL)] }, inputs)).toBeUndefined();
    });

    it('records a dry run with the actions', () => {
        expect(decideRun({ ...automation, status: 'dry-run' }, event, EMPTY_RUN_STATE, inputs)).toMatchObject({
            status: 'dry-run',
            detail: 'A dry run. The automation would: send to the agent.'
        });
    });
});

describe('scheduleEvent', () => {
    it('makes one key for each schedule time', () => {
        const slot = new Date(2026, 10, 23, 9, 0);
        expect(scheduleEvent({ id: 'nightly', binding: { repos: ['/repo'] } }, slot)).toEqual({
            trigger: 'schedule',
            key: `schedule:nightly:${slot.toISOString()}`,
            target: 'schedule:nightly',
            label: '2026-11-23 09:00',
            at: slot.getTime(),
            time: '09:00',
            repoPath: '/repo',
            worktreePath: '/repo'
        });
    });
});

describe('appOnlyActions', () => {
    it('lists the actions that the helper cannot run, also inside an "If" action', () => {
        expect(appOnlyActions(automation)).toEqual([]);
        expect(
            appOnlyActions({
                actions: [
                    {
                        type: 'if',
                        condition: { var: 'branch', op: 'equals', value: 'x' },
                        // biome-ignore lint/suspicious/noThenProperty: "then" is a list of actions, not a function, so the object is not a promise.
                        then: [{ type: 'moveTask', status: 'Done' }]
                    }
                ]
            })
        ).toEqual(['Move the task']);
        expect(waitForAppDetail(['Move the task']).startsWith(WAIT_FOR_APP_PREFIX)).toBe(true);
    });
});

describe('checksVariable', () => {
    it('lists the failed checks with the log of each Actions job', async () => {
        const checks = [
            { id: 1, name: 'build', conclusion: 'failure', isActions: true, url: 'https://ci/1' },
            { id: 2, name: 'lint', conclusion: 'success', isActions: true, url: 'https://ci/2' },
            { id: 3, name: 'deploy', conclusion: 'timed_out', isActions: false, url: 'https://ci/3' }
        ] as CheckRun[];
        expect(await checksVariable(checks, async check => `/logs/${check.id}.log`)).toBe(
            '- "build": the full log is in /logs/1.log\n- "deploy": the details are at https://ci/3'
        );
        expect(await checksVariable([], async () => undefined)).toContain('found no failed checks');
    });
});

describe('runHttpAction', () => {
    it('masks the secrets in the history and gives the answer as variables', async () => {
        const values: Record<string, string | undefined> = { 'http.status': '500' };
        const line = await runHttpAction(
            { binding: { secrets: { KEY: 'hidden' } } },
            { type: 'http', method: 'POST', url: 'https://example.com/{{secret.KEY}}', body: '{"a":1}' },
            values,
            async request => {
                expect(request).toEqual({
                    method: 'POST',
                    url: 'https://example.com/hidden',
                    headers: { 'Content-Type': 'application/json' },
                    body: '{"a":1}'
                });
                return { status: 200, statusText: 'OK', body: '{"ok":true}', truncated: false };
            }
        );
        expect(line).not.toContain('hidden');
        expect(values['http.status']).toBe('200');
    });

    it('throws for an answer that is not 2xx', async () => {
        await expect(
            runHttpAction({ binding: {} }, { type: 'http', method: 'GET', url: 'https://example.com' }, {}, async () => ({
                status: 404,
                statusText: 'Not Found',
                body: '',
                truncated: false
            }))
        ).rejects.toThrow('GET https://example.com: 404 Not Found');
    });
});

describe('pendingRemoteRuns', () => {
    it('gives the pending runs in the form of the phone API', () => {
        const runs = [{ ...past('pending', 'a'), worktreePath: '/wt' }, past('done', 'b')];
        expect(pendingRemoteRuns({ runs })).toEqual([
            { id: 'a', automationName: 'Fix CI', label: '#7 Fix login', trigger: 'ci.failed', worktreePath: '/wt', createdAt: NOW - 1000 }
        ]);
    });
});
