import { describe, expect, it } from 'vitest';
import type { CheckRun } from '@shared/github';
import {
    mapCheckRun,
    mapChecks,
    mapCommitStatus,
    mapJobProgress,
    mapRunJob,
    mapWorkflowRun,
    markOldAttempts,
    hasRepeatedJobs,
    type RestCheckRun,
    type RestStatus,
    type RestWorkflowRun
} from './actions-mapping';

const checkRun = (change: Partial<RestCheckRun> = {}): RestCheckRun => ({
    id: 10,
    name: 'test',
    status: 'completed',
    conclusion: 'failure',
    started_at: '2026-11-09T10:00:00Z',
    completed_at: '2026-11-09T10:05:00Z',
    details_url: 'https://github.com/acme/api/actions/runs/555/job/10',
    html_url: 'https://github.com/acme/api/runs/10',
    app: { slug: 'github-actions' },
    ...change
});

const status = (change: Partial<RestStatus> = {}): RestStatus => ({
    id: 20,
    context: 'ci/deploy',
    state: 'success',
    target_url: 'https://ci.example.com/build/1',
    created_at: '2026-11-09T10:00:00Z',
    updated_at: '2026-11-09T10:09:00Z',
    ...change
});

describe('mapCheckRun', () => {
    it('marks a GitHub Actions check and finds its run ID', () => {
        expect(mapCheckRun(checkRun())).toEqual({
            id: 10,
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            startedAt: '2026-11-09T10:00:00Z',
            completedAt: '2026-11-09T10:05:00Z',
            url: 'https://github.com/acme/api/runs/10',
            isActions: true,
            runId: 555
        });
    });

    it('gives no run ID to a check of another app', () => {
        const check = mapCheckRun(checkRun({ app: { slug: 'circleci' } }));
        expect(check.isActions).toBe(false);
        expect(check.runId).toBeUndefined();
    });

    it('gives no run ID to a check without an app', () => {
        expect(mapCheckRun(checkRun({ app: undefined })).isActions).toBe(false);
    });

    it('uses the details URL when the check has no HTML URL', () => {
        expect(mapCheckRun(checkRun({ html_url: null })).url).toBe('https://github.com/acme/api/actions/runs/555/job/10');
        expect(mapCheckRun(checkRun({ html_url: null, details_url: null })).url).toBeNull();
    });

    it.each([
        ['queued', null],
        ['in_progress', null],
        ['completed', 'success'],
        ['completed', 'cancelled'],
        ['completed', 'timed_out'],
        ['completed', 'skipped']
    ] as const)('keeps the status %s and the conclusion %s', (state, conclusion) => {
        const check = mapCheckRun(checkRun({ status: state, conclusion }));
        expect([check.status, check.conclusion]).toEqual([state, conclusion]);
    });
});

describe('mapCommitStatus', () => {
    it('changes a pending status to a check without a conclusion and an end time', () => {
        expect(mapCommitStatus(status({ state: 'pending' }))).toEqual({
            id: 20,
            name: 'ci/deploy',
            status: 'pending',
            conclusion: null,
            startedAt: '2026-11-09T10:00:00Z',
            completedAt: null,
            url: 'https://ci.example.com/build/1',
            isActions: false,
            isStatus: true
        });
    });

    it.each(['success', 'failure', 'error'] as const)('changes the %s state to a completed check with the same conclusion', state => {
        const check = mapCommitStatus(status({ state }));
        expect(check.status).toBe('completed');
        expect(check.conclusion).toBe(state);
        expect(check.completedAt).toBe('2026-11-09T10:09:00Z');
    });
});

describe('mapChecks', () => {
    it('keeps the newest check run of each name and keeps the job order of the first attempt', () => {
        const checks = mapChecks(
            [
                checkRun({ id: 1, name: 'test', conclusion: 'failure' }),
                checkRun({ id: 3, name: 'test', conclusion: 'success' }),
                checkRun({ id: 2, name: 'build' })
            ],
            [status({ id: 9, context: 'a-status' })]
        );
        expect(checks.map(check => [check.name, check.id])).toEqual([
            ['test', 3],
            ['build', 2],
            ['a-status', 9]
        ]);
    });

    it('puts the jobs in workflow order, groups them by run, and puts the other checks last by name', () => {
        const job = (id: number, name: string, runId: number) =>
            checkRun({ id, name, details_url: `https://github.com/acme/api/actions/runs/${runId}/job/${id}` });
        const checks = mapChecks(
            [
                checkRun({ id: 50, name: 'Socket: Report', app: { slug: 'socket' }, details_url: null }),
                job(14, 'merge-coverage', 700),
                checkRun({ id: 40, name: 'Socket: Alerts', app: { slug: 'socket' }, details_url: null }),
                job(21, 'lint', 800),
                job(11, 'docker-images', 700),
                job(13, 'test', 700),
                job(12, 'setup', 700)
            ],
            []
        );
        expect(checks.map(check => check.name)).toEqual(['docker-images', 'setup', 'test', 'merge-coverage', 'lint', 'Socket: Alerts', 'Socket: Report']);
    });

    it('keeps a commit status and a check run with the same name', () => {
        const checks = mapChecks([checkRun({ id: 1, name: 'deploy' })], [status({ id: 2, context: 'deploy' })]);
        expect(checks.map(check => check.isStatus ?? false)).toEqual([false, true]);
    });

    it('returns an empty list when the commit has no checks', () => {
        expect(mapChecks([], [])).toEqual([]);
    });
});

describe('mapJobProgress', () => {
    it('maps the job and each step', () => {
        expect(
            mapJobProgress({
                status: 'in_progress',
                conclusion: null,
                started_at: 's',
                completed_at: null,
                steps: [{ number: 1, name: 'Set up job', status: 'completed', conclusion: 'success', started_at: 'a', completed_at: 'b' }]
            })
        ).toEqual({
            status: 'in_progress',
            conclusion: null,
            startedAt: 's',
            completedAt: null,
            steps: [{ number: 1, name: 'Set up job', status: 'completed', conclusion: 'success', startedAt: 'a', completedAt: 'b' }]
        });
    });

    it('gives an empty step list to a job without steps', () => {
        expect(mapJobProgress({ status: 'queued', conclusion: null, started_at: null, completed_at: null }).steps).toEqual([]);
    });
});

describe('mapRunJob', () => {
    it('changes a job of a run to a GitHub Actions check with the run ID', () => {
        expect(
            mapRunJob({ id: 4, name: 'lint', status: 'completed', conclusion: 'failure', started_at: 'a', completed_at: 'b', html_url: 'u', run_id: 77 })
        ).toEqual({
            id: 4,
            name: 'lint',
            status: 'completed',
            conclusion: 'failure',
            startedAt: 'a',
            completedAt: 'b',
            url: 'u',
            runId: 77,
            isActions: true
        });
    });
});

describe('mapWorkflowRun', () => {
    const run = (change: Partial<RestWorkflowRun> = {}): RestWorkflowRun => ({
        id: 1,
        name: 'CI',
        display_title: 'Fix the parser',
        workflow_id: 5,
        run_number: 42,
        head_branch: 'main',
        head_sha: 'abc',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        actor: { login: 'ann' },
        triggering_actor: { login: 'bob' },
        created_at: 'c',
        updated_at: 'u',
        run_started_at: 's',
        html_url: 'h',
        ...change
    });

    it('maps all fields of a run', () => {
        expect(mapWorkflowRun(run())).toEqual({
            id: 1,
            title: 'Fix the parser',
            workflowId: 5,
            workflowName: 'CI',
            runNumber: 42,
            branch: 'main',
            event: 'push',
            status: 'completed',
            conclusion: 'success',
            actor: 'bob',
            createdAt: 'c',
            updatedAt: 'u',
            startedAt: 's',
            url: 'h',
            headSha: 'abc'
        });
    });

    it('uses the name, then the run number, when the run has no title', () => {
        expect(mapWorkflowRun(run({ display_title: undefined })).title).toBe('CI');
        expect(mapWorkflowRun(run({ display_title: undefined, name: null })).title).toBe('Run 42');
        expect(mapWorkflowRun(run({ name: null })).workflowName).toBe('');
    });

    it('uses the first actor when the run has no triggering actor', () => {
        expect(mapWorkflowRun(run({ triggering_actor: null })).actor).toBe('ann');
        expect(mapWorkflowRun(run({ triggering_actor: null, actor: null })).actor).toBeNull();
    });

    it('gives the queued status to a run without a status, and no start time to a run without one', () => {
        const mapped = mapWorkflowRun(run({ status: null, run_started_at: undefined }));
        expect(mapped.status).toBe('queued');
        expect(mapped.startedAt).toBeNull();
    });
});

describe('markOldAttempts', () => {
    const job = (change: Partial<CheckRun>): CheckRun => ({
        id: 1,
        name: 'test',
        status: 'completed',
        conclusion: 'failure',
        startedAt: '2026-11-18T10:00:00Z',
        completedAt: '2026-11-18T10:05:00Z',
        url: 'u',
        runId: 900,
        isActions: true,
        ...change
    });
    const activeRun = { id: 900, workflow_id: 7, event: 'pull_request', status: 'in_progress', run_started_at: '2026-11-18T11:00:00Z' };

    it('shows a failed or skipped job from an older attempt of an active run as queued', () => {
        const [failed, skipped] = markOldAttempts([job({}), job({ id: 2, name: 'lint', conclusion: 'skipped' })], [activeRun]);
        for (const check of [failed, skipped]) {
            expect(check).toMatchObject({ status: 'queued', conclusion: null, startedAt: null, completedAt: null, waitingForRerun: true });
        }
    });

    it('keeps a passed job, a job of the new attempt, and a job of a completed run', () => {
        const checks = [
            job({ conclusion: 'success' }),
            job({ id: 2, completedAt: '2026-11-18T11:02:00Z' }),
            job({ id: 3, runId: 901 }),
            job({ id: 4, isActions: false, runId: undefined })
        ];
        const runs = [activeRun, { id: 901, workflow_id: 8, event: 'pull_request', status: 'completed', run_started_at: '2026-11-18T11:00:00Z' }];
        expect(markOldAttempts(checks, runs)).toEqual(checks);
    });

    it('shows the jobs of a run that an active newer run of the same workflow replaces as queued', () => {
        const oldRun = { id: 800, workflow_id: 7, event: 'pull_request', status: 'completed', run_started_at: '2026-11-18T09:00:00Z' };
        const checks = [
            job({ id: 1, runId: 800 }),
            job({ id: 2, name: 'lint', runId: 800, conclusion: 'success' }),
            job({ id: 3, name: 'setup', status: 'in_progress', conclusion: null, completedAt: null })
        ];
        const [failed, passed, running] = markOldAttempts(checks, [oldRun, activeRun]);
        for (const check of [failed, passed]) {
            expect(check).toMatchObject({ status: 'queued', conclusion: null, waitingForRerun: true, runId: 800, newerRunId: 900 });
        }
        expect(running).toBe(checks[2]);
    });

    it('removes the jobs of a replaced run when the newer run completes', () => {
        const runs = [
            { id: 800, workflow_id: 7, event: 'pull_request', status: 'completed', run_started_at: '2026-11-18T09:00:00Z' },
            { id: 900, workflow_id: 7, event: 'pull_request', status: 'completed', run_started_at: '2026-11-18T11:00:00Z' }
        ];
        const kept = job({ id: 2, name: 'setup', conclusion: 'success' });
        expect(markOldAttempts([job({ id: 1, runId: 800 }), kept], runs)).toEqual([kept]);
    });

    it('keeps the jobs of a run of another workflow or another event', () => {
        const checks = [job({ id: 1, runId: 800, conclusion: 'success' }), job({ id: 2, name: 'lint', runId: 801, conclusion: 'success' })];
        const runs = [
            activeRun,
            { id: 800, workflow_id: 8, event: 'pull_request', status: 'completed', run_started_at: '2026-11-18T09:00:00Z' },
            { id: 801, workflow_id: 7, event: 'push', status: 'completed', run_started_at: '2026-11-18T09:00:00Z' }
        ];
        expect(markOldAttempts(checks, runs)).toEqual(checks);
    });
});

describe('hasRepeatedJobs', () => {
    const job = (id: number, name: string, runId: number) => checkRun({ id, name, details_url: `https://github.com/acme/api/actions/runs/${runId}/job/${id}` });

    it('is true when a job name is in two runs', () => {
        expect(hasRepeatedJobs([job(1, 'setup', 800), job(2, 'setup', 900)])).toBe(true);
    });

    it('is false for other names, the same run, or a check that is not a GitHub Actions job', () => {
        expect(
            hasRepeatedJobs([job(1, 'setup', 800), job(2, 'setup', 800), job(3, 'lint', 900), checkRun({ id: 4, name: 'lint', app: { slug: 'socket' } })])
        ).toBe(false);
    });
});
