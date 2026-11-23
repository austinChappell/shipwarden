import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubError } from './github-client';
import { fakeClient, type FakeCall } from './fake-client';
import {
    approveDeployments,
    cancelRun,
    dispatchWorkflow,
    fetchChecks,
    fetchJobLog,
    fetchJobProgress,
    fetchPendingApprovals,
    fetchRunJobs,
    fetchWorkflowRuns,
    fetchWorkflows,
    jobLogFolder,
    rerunFailedJobs,
    rerunJob,
    rerunRun,
    saveJobLog
} from './actions';

const repo = { owner: 'acme', name: 'api' };

const RAW_LOG =
    '﻿2026-11-09T10:00:00.1234567Z ##[group]Run npm test\n2026-11-09T10:00:01Z \x1b[31mFAIL\x1b[0m src/a.test.ts\r\n2026-11-09T10:00:02Z Error: expected 1 to be 2';

describe('re-run and cancel', () => {
    it.each([
        ['rerunJob', () => rerunJob, 31, '/repos/acme/api/actions/jobs/31/rerun'],
        ['rerunFailedJobs', () => rerunFailedJobs, 900, '/repos/acme/api/actions/runs/900/rerun-failed-jobs'],
        ['rerunRun', () => rerunRun, 900, '/repos/acme/api/actions/runs/900/rerun'],
        ['cancelRun', () => cancelRun, 900, '/repos/acme/api/actions/runs/900/cancel']
    ] as const)('%s sends one POST request without a body', async (_name, action, id, expected) => {
        const { client, calls } = fakeClient();
        await action()(client, repo, id);
        expect(calls).toEqual([{ kind: 'rest', method: 'POST', path: expected, body: undefined }]);
    });

    it('gives the error of a refused re-run to the caller', async () => {
        const { client } = fakeClient(() => Promise.reject(new GitHubError('GitHub returned 403.', 403)));
        await expect(rerunJob(client, repo, 31)).rejects.toMatchObject({ status: 403 });
        await expect(rerunFailedJobs(client, repo, 900)).rejects.toMatchObject({ status: 403 });
    });
});

describe('fetchJobLog', () => {
    it('reads the log with the JSON accept header and removes the time stamps and the color codes', async () => {
        const { client, calls } = fakeClient(() => RAW_LOG);
        const log = await fetchJobLog(client, repo, 31);
        expect(calls).toEqual([{ kind: 'text', method: 'GET', path: '/repos/acme/api/actions/jobs/31/logs', accept: 'application/vnd.github+json' }]);
        expect(log).toBe('##[group]Run npm test\nFAIL src/a.test.ts\nError: expected 1 to be 2');
    });

    it('gives the error of a missing log to the caller', async () => {
        const { client } = fakeClient(() => Promise.reject(new GitHubError('GitHub returned 404.', 404)));
        await expect(fetchJobLog(client, repo, 31)).rejects.toMatchObject({ status: 404 });
    });
});

describe('saveJobLog', () => {
    let folder: string;

    beforeEach(async () => {
        folder = await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-logs-'));
    });

    afterEach(async () => {
        await fs.rm(folder, { recursive: true, force: true });
    });

    it('writes the clean log to a file with the repository and the job ID in its name', async () => {
        const { client } = fakeClient(() => RAW_LOG);
        const target = path.join(folder, 'nested');
        const file = await saveJobLog(client, repo, 31, target);
        expect(file).toBe(path.join(target, 'acme-api-job-31.log'));
        expect(await fs.readFile(file, 'utf8')).toBe('##[group]Run npm test\nFAIL src/a.test.ts\nError: expected 1 to be 2');
    });

    it('writes no file when the log does not load', async () => {
        const { client } = fakeClient(() => Promise.reject(new GitHubError('GitHub returned 410.', 410)));
        await expect(saveJobLog(client, repo, 31, folder)).rejects.toMatchObject({ status: 410 });
        expect(await fs.readdir(folder)).toEqual([]);
    });

    it('uses the ci-logs folder in the home folder by default', () => {
        expect(jobLogFolder()).toBe(path.join(os.homedir(), '.shipwarden', 'ci-logs'));
    });
});

describe('fetchChecks', () => {
    it('reads the check runs and the commit statuses of the commit and joins them', async () => {
        const { client, calls } = fakeClient(call =>
            call.kind === 'paginate'
                ? {
                      check_runs: [
                          {
                              id: 2,
                              name: 'test',
                              status: 'completed',
                              conclusion: 'failure',
                              started_at: null,
                              completed_at: null,
                              details_url: null,
                              html_url: 'h',
                              app: { slug: 'github-actions' }
                          }
                      ]
                  }
                : { statuses: [{ id: 5, context: 'deploy', state: 'error', target_url: 't', created_at: 'c', updated_at: 'u' }] }
        );
        const checks = await fetchChecks(client, repo, 'sha1');
        expect(calls.map(call => [call.kind, call.path, call.limit])).toEqual([
            ['paginate', '/repos/acme/api/commits/sha1/check-runs', 500],
            ['rest', '/repos/acme/api/commits/sha1/status', undefined]
        ]);
        expect(checks.map(check => [check.name, check.conclusion, check.isActions])).toEqual([
            ['test', 'failure', true],
            ['deploy', 'error', false]
        ]);
    });
});

describe('fetchChecks with a re-run', () => {
    const failedJob = {
        id: 2,
        name: 'test',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-11-18T10:00:00Z',
        completed_at: '2026-11-18T10:05:00Z',
        details_url: 'https://github.com/acme/api/actions/runs/900/job/2',
        html_url: 'h',
        app: { slug: 'github-actions' }
    };

    it('reads the runs of the commit and shows a failed job of an older attempt as queued', async () => {
        const { client, calls } = fakeClient(call => {
            if (call.kind === 'paginate') return { check_runs: [failedJob] };
            if (call.path.includes('/actions/runs')) {
                return { workflow_runs: [{ id: 900, workflow_id: 7, event: 'pull_request', status: 'in_progress', run_started_at: '2026-11-18T11:00:00Z' }] };
            }
            return { statuses: [] };
        });
        const checks = await fetchChecks(client, repo, 'sha1');
        expect(calls.map(call => call.path)).toContain('/repos/acme/api/actions/runs?head_sha=sha1&per_page=100');
        expect(checks[0]).toMatchObject({ name: 'test', status: 'queued', conclusion: null, waitingForRerun: true });
    });

    it('sends no runs request when all jobs passed', async () => {
        const { client, calls } = fakeClient(call => (call.kind === 'paginate' ? { check_runs: [{ ...failedJob, conclusion: 'success' }] } : { statuses: [] }));
        await fetchChecks(client, repo, 'sha1');
        expect(calls).toHaveLength(2);
    });

    it('shows a job of a replaced run as queued while the newer run of the workflow is active', async () => {
        const job = (id: number, name: string, runId: number, conclusion: string | null) => ({
            ...failedJob,
            id,
            name,
            conclusion,
            status: conclusion ? 'completed' : 'in_progress',
            details_url: `https://github.com/acme/api/actions/runs/${runId}/job/${id}`
        });
        const { client } = fakeClient(call => {
            if (call.kind === 'paginate') {
                return { check_runs: [job(1, 'setup', 800, 'success'), job(2, 'merge-coverage', 800, 'success'), job(3, 'setup', 900, null)] };
            }
            if (call.path.includes('/actions/runs')) {
                return {
                    workflow_runs: [
                        { id: 900, workflow_id: 7, event: 'pull_request', status: 'in_progress', run_started_at: '2026-11-18T11:00:00Z' },
                        { id: 800, workflow_id: 7, event: 'pull_request', status: 'completed', run_started_at: '2026-11-18T10:00:00Z' }
                    ]
                };
            }
            return { statuses: [] };
        });
        const checks = await fetchChecks(client, repo, 'sha1');
        expect(checks.map(check => [check.name, check.status])).toEqual([
            ['merge-coverage', 'queued'],
            ['setup', 'in_progress']
        ]);
    });
});

describe('fetchJobProgress', () => {
    it('reads the job and maps its steps', async () => {
        const { client, calls } = fakeClient(() => ({ status: 'in_progress', conclusion: null, started_at: 's', completed_at: null }));
        expect(await fetchJobProgress(client, repo, 31)).toEqual({ status: 'in_progress', conclusion: null, startedAt: 's', completedAt: null, steps: [] });
        expect(calls[0]).toMatchObject({ method: 'GET', path: '/repos/acme/api/actions/jobs/31' });
    });
});

describe('fetchWorkflows', () => {
    const list = {
        workflows: [
            { id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
            { id: 2, name: 'Old', path: '.github/workflows/old.yml', state: 'disabled_manually' },
            { id: 3, name: 'Dependabot', path: 'dynamic/dependabot/dependabot-updates', state: 'active' },
            { id: 4, name: 'Deploy', path: '.github/workflows/deploy.yml', state: 'active' }
        ]
    };

    it('keeps the active workflow files and reads the trigger of each file on the ref', async () => {
        const { client, calls } = fakeClient((call: FakeCall) => {
            if (call.kind === 'paginate') return list;
            if (call.path.includes('ci.yml')) return 'on: [push, workflow_dispatch]';
            return Promise.reject(new GitHubError('Not found', 404));
        });
        const workflows = await fetchWorkflows(client, repo, 'feature/x');
        expect(workflows).toEqual([
            { id: 1, name: 'CI', path: '.github/workflows/ci.yml', dispatchable: true, inputs: [] },
            { id: 4, name: 'Deploy', path: '.github/workflows/deploy.yml', dispatchable: false, inputs: [] }
        ]);
        expect(calls.filter(call => call.kind === 'text').map(call => call.path)).toEqual([
            '/repos/acme/api/contents/.github/workflows/ci.yml?ref=feature%2Fx',
            '/repos/acme/api/contents/.github/workflows/deploy.yml?ref=feature%2Fx'
        ]);
    });
});

describe('dispatchWorkflow', () => {
    it('sends the inputs only when the user gave values', async () => {
        const { client, calls } = fakeClient();
        await dispatchWorkflow(client, repo, 4, 'main', { env: 'prod' });
        await dispatchWorkflow(client, repo, 4, 'main', {});
        await dispatchWorkflow(client, repo, 4, 'main');
        expect(calls.map(call => call.body)).toEqual([{ ref: 'main', inputs: { env: 'prod' } }, { ref: 'main' }, { ref: 'main' }]);
        expect(calls[0]).toMatchObject({ method: 'POST', path: '/repos/acme/api/actions/workflows/4/dispatches' });
    });
});

describe('fetchWorkflowRuns', () => {
    it('reads the runs of the repository or of one workflow', async () => {
        const { client, calls } = fakeClient(() => ({ workflow_runs: [] }));
        await fetchWorkflowRuns(client, repo);
        await fetchWorkflowRuns(client, repo, 4);
        expect(calls.map(call => call.path)).toEqual(['/repos/acme/api/actions/runs?per_page=40', '/repos/acme/api/actions/workflows/4/runs?per_page=40']);
    });
});

describe('fetchRunJobs', () => {
    it('reads the jobs of the latest attempt as GitHub Actions checks', async () => {
        const { client, calls } = fakeClient(() => ({
            jobs: [{ id: 8, name: 'build', status: 'completed', conclusion: 'failure', started_at: null, completed_at: null, html_url: 'h', run_id: 900 }]
        }));
        const jobs = await fetchRunJobs(client, repo, 900);
        expect(calls[0].path).toBe('/repos/acme/api/actions/runs/900/jobs?filter=latest');
        expect(jobs).toEqual([
            { id: 8, name: 'build', status: 'completed', conclusion: 'failure', startedAt: null, completedAt: null, url: 'h', runId: 900, isActions: true }
        ]);
    });
});

describe('fetchPendingApprovals', () => {
    const run = (id: number, title: string, workflowId = 7) => ({
        id,
        name: 'Deploy',
        display_title: title,
        workflow_id: workflowId,
        run_number: id,
        head_branch: 'main',
        head_sha: 'abc',
        event: 'push',
        status: 'waiting',
        conclusion: null,
        actor: { login: 'sam' },
        triggering_actor: { login: 'lee' },
        created_at: '2026-11-20T10:00:00Z',
        updated_at: '2026-11-20T10:00:00Z',
        html_url: `https://github.com/acme/api/actions/runs/${id}`
    });

    it('returns the waiting runs with the environments that the user can approve', async () => {
        const { client, calls } = fakeClient(call => {
            if (call.path.endsWith('status=waiting&per_page=10')) return { workflow_runs: [run(1, 'Release 1.2'), run(2, 'Release 1.3', 8)] };
            if (call.path.includes('/workflows/7/')) return { workflow_runs: [run(1, 'Release 1.2')] };
            if (call.path.includes('/workflows/8/')) return { workflow_runs: [run(2, 'Release 1.3', 8)] };
            if (call.path.includes('/runs/1/')) {
                return [
                    { environment: { id: 11, name: 'production' }, current_user_can_approve: true },
                    { environment: { id: 12, name: 'staging' }, current_user_can_approve: false }
                ];
            }
            return [{ environment: { id: 11, name: 'production' }, current_user_can_approve: false }];
        });
        const items = await fetchPendingApprovals(client, repo);
        expect(calls.map(call => call.path)).toEqual([
            '/repos/acme/api/actions/runs?status=waiting&per_page=10',
            '/repos/acme/api/actions/workflows/7/runs?per_page=1',
            '/repos/acme/api/actions/workflows/8/runs?per_page=1',
            '/repos/acme/api/actions/runs/1/pending_deployments',
            '/repos/acme/api/actions/runs/2/pending_deployments'
        ]);
        expect(items).toEqual([
            {
                id: 'github:acme/api:1',
                source: 'api',
                sourceTitle: 'acme/api',
                workflow: 'Deploy',
                title: 'Release 1.2',
                environments: ['production'],
                branch: 'main',
                actor: 'lee',
                url: 'https://github.com/acme/api/actions/runs/1',
                createdAt: '2026-11-20T10:00:00Z',
                target: { kind: 'github', repo, runId: 1, environmentIds: [11] }
            }
        ]);
    });

    it('returns only the newest waiting run of a workflow', async () => {
        const { client, calls } = fakeClient(call => {
            if (call.path.endsWith('status=waiting&per_page=10')) return { workflow_runs: [run(3, 'Release 1.4'), run(1, 'Release 1.2')] };
            if (call.path.includes('/workflows/')) return { workflow_runs: [run(3, 'Release 1.4')] };
            return [{ environment: { id: 11, name: 'production' }, current_user_can_approve: true }];
        });
        const items = await fetchPendingApprovals(client, repo);
        expect(items.map(item => item.target)).toEqual([{ kind: 'github', repo, runId: 3, environmentIds: [11] }]);
        expect(calls.some(call => call.path.includes('/runs/1/'))).toBe(false);
    });

    it('returns no run when a newer run of the workflow does not wait', async () => {
        const { client, calls } = fakeClient(call => {
            if (call.path.endsWith('status=waiting&per_page=10')) return { workflow_runs: [run(1, 'Release 1.2')] };
            if (call.path.includes('/workflows/')) return { workflow_runs: [{ ...run(5, 'Release 1.5'), status: 'in_progress' }] };
            return [{ environment: { id: 11, name: 'production' }, current_user_can_approve: true }];
        });
        expect(await fetchPendingApprovals(client, repo)).toEqual([]);
        expect(calls.some(call => call.path.includes('pending_deployments'))).toBe(false);
    });

    it('sends one request when no run is waiting', async () => {
        const { client, calls } = fakeClient(() => ({ workflow_runs: [] }));
        expect(await fetchPendingApprovals(client, repo)).toEqual([]);
        expect(calls).toHaveLength(1);
    });
});

describe('approveDeployments', () => {
    it('approves the environments of the run with an empty comment', async () => {
        const { client, calls } = fakeClient();
        await approveDeployments(client, repo, 900, [11, 12]);
        expect(calls).toEqual([
            {
                kind: 'rest',
                method: 'POST',
                path: '/repos/acme/api/actions/runs/900/pending_deployments',
                body: { environment_ids: [11, 12], state: 'approved', comment: '' }
            }
        ]);
    });
});
