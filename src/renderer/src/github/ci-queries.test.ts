import { describe, expect, it } from 'vitest';
import type { CheckRun } from '@shared/github';
import type { WorkflowRun } from '@shared/pipelines';
import { STALE_MS } from '../query-client';
import { cancelChecks, cancelRunIn, checksRunning, liveInterval, queueChecks, queueRun, runsActive, sortWorkflows } from './ci-queries';

const NOW = '2026-11-10T12:00:00Z';

const job = (id: number, status: CheckRun['status'], conclusion: CheckRun['conclusion'], runId = 7): CheckRun => ({
    id,
    name: `job ${id}`,
    status,
    conclusion,
    startedAt: '2026-11-10T11:00:00Z',
    completedAt: status === 'completed' ? '2026-11-10T11:05:00Z' : null,
    url: null,
    runId,
    isActions: true
});

const run = (id: number, status: string, conclusion: string | null): WorkflowRun => ({
    id,
    title: `run ${id}`,
    workflowId: 1,
    workflowName: 'CI',
    runNumber: id,
    branch: 'main',
    event: 'push',
    status,
    conclusion,
    actor: null,
    createdAt: '2026-11-10T11:00:00Z',
    updatedAt: '2026-11-10T11:05:00Z',
    startedAt: '2026-11-10T11:00:00Z',
    url: '',
    headSha: 'abc'
});

describe('liveInterval', () => {
    it('uses the fast interval while the data is live', () => {
        expect(liveInterval(true, 8000)).toBe(8000);
    });

    it('uses the default interval when the data is complete', () => {
        expect(liveInterval(false, 8000)).toBe(STALE_MS);
    });
});

describe('checksRunning and runsActive', () => {
    it('finds a check or a run that waits or runs', () => {
        expect(checksRunning([job(1, 'completed', 'success'), job(2, 'queued', null)])).toBe(true);
        expect(checksRunning([job(1, 'completed', 'success')])).toBe(false);
        expect(checksRunning(undefined)).toBe(false);
        expect(runsActive([run(1, 'completed', 'success'), run(2, 'in_progress', null)])).toBe(true);
        expect(runsActive([run(1, 'completed', 'failure')])).toBe(false);
    });
});

describe('sortWorkflows', () => {
    it('sorts by name and keeps the given list', () => {
        const list = [
            { id: 1, name: 'b', path: 'b.yml', dispatchable: false, inputs: [] },
            { id: 2, name: 'a', path: 'a.yml', dispatchable: true, inputs: [] }
        ];
        expect(sortWorkflows(list).map(item => item.id)).toEqual([2, 1]);
        expect(list[0].id).toBe(1);
    });
});

describe('queueRun', () => {
    it('marks the run as queued', () => {
        const result = queueRun([run(1, 'completed', 'failure'), run(2, 'completed', 'success')], 1, NOW);
        expect(result[0]).toMatchObject({ status: 'queued', conclusion: null, updatedAt: NOW });
        expect(result[1].status).toBe('completed');
    });

    it('returns the same list when no run matches', () => {
        const runs = [run(1, 'completed', 'failure')];
        expect(queueRun(runs, 9, NOW)).toBe(runs);
    });
});

describe('cancelRunIn', () => {
    it('marks an active run as cancelled', () => {
        expect(cancelRunIn([run(1, 'in_progress', null)], 1, NOW)[0]).toMatchObject({ status: 'completed', conclusion: 'cancelled' });
    });

    it('does not change a completed run', () => {
        const runs = [run(1, 'completed', 'success')];
        expect(cancelRunIn(runs, 1, NOW)).toBe(runs);
    });
});

describe('queueChecks', () => {
    it('marks only the matching checks as queued', () => {
        const result = queueChecks([job(1, 'completed', 'failure'), job(2, 'completed', 'success')], check => check.conclusion === 'failure');
        expect(result[0]).toMatchObject({ status: 'queued', conclusion: null, startedAt: null, completedAt: null });
        expect(result[1].conclusion).toBe('success');
    });
});

describe('cancelChecks', () => {
    it('marks the matching checks that do not complete as cancelled', () => {
        const result = cancelChecks([job(1, 'in_progress', null), job(2, 'completed', 'success'), job(3, 'queued', null, 8)], check => check.runId === 7, NOW);
        expect(result[0]).toMatchObject({ status: 'completed', conclusion: 'cancelled', completedAt: NOW });
        expect(result[1].conclusion).toBe('success');
        expect(result[2].status).toBe('queued');
    });
});
