import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubError } from './github-client';
import { fakeClient, type FakeCall } from './fake-client';
import {
    cancelRun,
    dispatchWorkflow,
    fetchChecks,
    fetchJobLog,
    fetchJobProgress,
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

const RAW_LOG = '﻿2026-11-09T10:00:00.1234567Z ##[group]Run npm test\n2026-11-09T10:00:01Z \x1b[31mFAIL\x1b[0m src/a.test.ts\r\n2026-11-09T10:00:02Z Error: expected 1 to be 2';

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
        const { client, calls } = fakeClient(call => call.kind === 'paginate'
            ? { check_runs: [{ id: 2, name: 'test', status: 'completed', conclusion: 'failure', started_at: null, completed_at: null, details_url: null, html_url: 'h', app: { slug: 'github-actions' } }] }
            : { statuses: [{ id: 5, context: 'deploy', state: 'error', target_url: 't', created_at: 'c', updated_at: 'u' }] });
        const checks = await fetchChecks(client, repo, 'sha1');
        expect(calls.map(call => [call.kind, call.path, call.limit])).toEqual([
            ['paginate', '/repos/acme/api/commits/sha1/check-runs', 500],
            ['rest', '/repos/acme/api/commits/sha1/status', undefined]
        ]);
        expect(checks.map(check => [check.name, check.conclusion, check.isActions])).toEqual([['deploy', 'error', false], ['test', 'failure', true]]);
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
        expect(calls.map(call => call.path)).toEqual([
            '/repos/acme/api/actions/runs?per_page=40',
            '/repos/acme/api/actions/workflows/4/runs?per_page=40'
        ]);
    });
});

describe('fetchRunJobs', () => {
    it('reads the jobs of the latest attempt as GitHub Actions checks', async () => {
        const { client, calls } = fakeClient(() => ({
            jobs: [{ id: 8, name: 'build', status: 'completed', conclusion: 'failure', started_at: null, completed_at: null, html_url: 'h', run_id: 900 }]
        }));
        const jobs = await fetchRunJobs(client, repo, 900);
        expect(calls[0].path).toBe('/repos/acme/api/actions/runs/900/jobs?filter=latest');
        expect(jobs).toEqual([{ id: 8, name: 'build', status: 'completed', conclusion: 'failure', startedAt: null, completedAt: null, url: 'h', runId: 900, isActions: true }]);
    });
});
