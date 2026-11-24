import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import type { PullRequestChange } from '@shared/github';
import type { GiteaClient } from './gitea-client';
import { GiteaError } from './gitea-client';
import { GiteaService } from './gitea-service';
import commitsJson from './fixtures/commits.json';
import issueCommentsJson from './fixtures/issue-comments.json';
import jobsJson from './fixtures/jobs.json';
import pullRequestJson from './fixtures/pull-request.json';
import repoJson from './fixtures/repo.json';
import comments101 from './fixtures/review-comments-101.json';
import comments102 from './fixtures/review-comments-102.json';
import reviewsJson from './fixtures/reviews.json';
import runsJson from './fixtures/runs.json';
import statusJson from './fixtures/status.json';
import tasksJson from './fixtures/tasks.json';

const ROOT = '/work/api';
const API = '/repos/acme/api';
const PULL = `${API}/pulls/7`;
const REF = { owner: 'git.example.com/acme', name: 'api', host: 'gitea' as const };
const SHA = '2222222222222222222222222222222222222222';
const diff = readFileSync(new URL('./fixtures/pull-request.diff', import.meta.url), 'utf8');
const notFound = () => new GiteaError('git.example.com returned 404.', 404);

/** The answers of a server with the newer Actions API. A test can replace an answer or give an error. */
function defaultAnswers(): Record<string, unknown> {
    return {
        [`${PULL}/reviews/101/comments`]: comments101,
        [`${PULL}/reviews/102/comments`]: comments102,
        [`${PULL}/reviews`]: reviewsJson,
        [`${PULL}/commits`]: commitsJson,
        [`${API}/issues/7/comments`]: issueCommentsJson,
        [`${API}/actions/runs/52/jobs`]: jobsJson,
        [`${API}/actions/runs`]: runsJson,
        [`${API}/commits/${SHA}/status`]: statusJson,
        [`${API}/labels`]: [{ id: 5, name: 'api', color: 'e11d21' }],
        [PULL]: pullRequestJson
    };
}

/** Records the requests of the service and gives fixed answers, without a network. The path without the query is the key. */
function recordCalls(answers: Record<string, unknown> = {}, version = '1.24.3') {
    const all = { ...defaultAnswers(), ...answers };
    const keys = Object.keys(all);
    const calls: [string, string, unknown][] = [];
    const answer = (method: string, url: string, body?: unknown) => {
        calls.push([method, url, body]);
        if (url === API) return repoJson;
        if (url === '/user') return { id: 30, login: 'viewer' };
        const path = url.replace(/\?.*$/, '');
        const value = keys.includes(path) ? all[path] : undefined;
        if (value instanceof Error) throw value;
        if (typeof value === 'function') return (value as (method: string) => unknown)(method);
        return value;
    };
    const client = {
        host: () => 'git.example.com',
        baseUrl: () => 'https://git.example.com',
        version: async () => version,
        request: async (method: string, url: string, body?: unknown) => answer(method, url, body),
        all: async (url: string) => (answer('GET', url) as unknown[]) ?? [],
        text: async (url: string) => {
            const value = answer('GET', url);
            if (typeof value === 'string') return value;
            if (url.endsWith('.diff')) return diff;
            return '2026-11-20T11:00:01.1234567Z \x1b[31merror\x1b[0m lint failed\n';
        },
        form: async (url: string) => answer('POST', url)
    } as unknown as GiteaClient;
    const service = new GiteaService(client, async root =>
        root === ROOT ? 'git@git.example.com:acme/api.git' : root === '/work/other' ? 'git@codeberg.org:acme/api.git' : 'git@github.com:acme/api.git'
    );
    const changes = () => calls.filter(([method]) => method !== 'GET');
    return { calls, changes, service };
}

describe('GiteaService', () => {
    it('owns only worktrees and references of its server', async () => {
        const { service } = recordCalls();
        expect(await service.owns(ROOT)).toBe(true);
        expect(await service.owns('/work/other')).toBe(false);
        expect(await service.owns('/work/github')).toBe(false);
        expect(await service.owns(REF)).toBe(true);
        expect(await service.owns({ owner: 'codeberg.org/acme', name: 'api', host: 'gitea' })).toBe(false);
    });

    it('loads a pull request with its reviews, line comments, conversation, and commits', async () => {
        const { calls, service } = recordCalls();
        const pr = await service.pullRequest(REF, 7);
        expect(pr.title).toBe('Add rate limits');
        expect(pr.threads).toHaveLength(2);
        expect(pr.reviewDecision).toBe('APPROVED');
        // Only the submitted reviews with comments need a request for their comments.
        const reviewRequests = calls.map(([, url]) => url).filter(url => /\/reviews\/\d+\/comments/.test(url));
        expect(reviewRequests).toEqual([`${PULL}/reviews/101/comments`, `${PULL}/reviews/102/comments`]);
    });

    it('reads the files of a pull request from its diff', async () => {
        const { service } = recordCalls();
        await service.setFileViewed('gitea:git.example.com/acme/api/7', 'src/limits.ts', true);
        const files = await service.pullRequestFiles(REF, 7);
        expect(files.map(file => [file.path, file.status, file.viewed])).toEqual([
            ['README.md', 'modified', false],
            ['src/limits.ts', 'added', true],
            ['new/name.ts', 'renamed', false],
            ['logo.png', 'removed', false]
        ]);
    });

    it('gives the jobs of the newest runs and the statuses of other CI systems as checks', async () => {
        const { calls, service } = recordCalls();
        const checks = await service.checks(REF, SHA);
        expect(checks.map(check => [check.name, check.conclusion, check.isActions, check.runId])).toEqual([
            ['test', 'success', true, 52],
            ['lint', 'failure', true, 52],
            ['external/build', null, false, undefined]
        ]);
        // Run 51 is an older run of the same workflow, so its jobs do not load.
        expect(calls.some(([, url]) => url.includes('/actions/runs/51/jobs'))).toBe(false);
    });

    it('uses the commit statuses and the task list on a server with the older Actions API', async () => {
        const { service } = recordCalls({ [`${API}/actions/runs`]: notFound(), [`${API}/actions/tasks`]: tasksJson });
        const checks = await service.checks(REF, SHA);
        expect(checks.map(check => [check.name, check.isStatus, check.isActions])).toEqual([
            ['ci / test (push)', true, false],
            ['ci / lint (push)', true, false],
            ['external/build', true, false]
        ]);
        const runs = await service.workflowRuns(REF);
        expect(runs.map(run => [run.id, run.workflowName, run.conclusion])).toEqual([
            [14, 'ci.yml', 'failure'],
            [12, 'nightly.yaml', null]
        ]);
        expect((await service.runJobs(REF, 14)).map(job => job.name)).toEqual(['lint', 'test']);
        await expect(service.jobLog(REF, 310)).rejects.toThrow('no Actions API for jobs');
    });

    it('gives no runs on a server without an Actions API', async () => {
        const { service } = recordCalls({ [`${API}/actions/runs`]: notFound(), [`${API}/actions/tasks`]: notFound() });
        expect(await service.workflowRuns(REF)).toEqual([]);
        expect((await service.checks(REF, SHA)).every(check => check.isStatus)).toBe(true);
    });

    it('reads a job log and its steps with the newer Actions API', async () => {
        const { service } = recordCalls({ [`${API}/actions/jobs/78`]: jobsJson.jobs[0] });
        expect(await service.jobLog(REF, 78)).toBe('error lint failed\n');
        expect((await service.jobProgress(REF, 78)).steps).toHaveLength(2);
    });

    it('runs a job again with the run of the job, and explains a missing API', async () => {
        const { changes, service } = recordCalls({
            [`${API}/actions/jobs/78`]: jobsJson.jobs[0],
            [`${API}/actions/runs/52/jobs/78/rerun`]: undefined,
            [`${API}/actions/runs/52/cancel`]: notFound()
        });
        await service.rerunJob(REF, 78);
        expect(changes()).toEqual([['POST', `${API}/actions/runs/52/jobs/78/rerun`, undefined]]);
        await expect(service.cancelRun(REF, 52)).rejects.toThrow('This server has no API to cancel a run.');
    });

    it('merges with the method and the head commit', async () => {
        const { changes, service } = recordCalls({ [`${PULL}/merge`]: undefined });
        await service.merge(REF, 7, SHA, 'squash');
        expect(changes()).toEqual([['POST', `${PULL}/merge`, { Do: 'squash', head_commit_id: SHA }]]);
    });

    it.each<[PullRequestChange, [string, string, unknown][]]>([
        [{ kind: 'base', base: 'release' }, [['PATCH', PULL, { base: 'release' }]]],
        [{ kind: 'details', title: 'New title', state: 'closed' }, [['PATCH', PULL, { title: 'New title', state: 'closed' }]]],
        [{ kind: 'draft', pullRequestId: 'x', draft: true }, [['PATCH', PULL, { title: 'WIP: Add rate limits' }]]],
        [{ kind: 'draft', pullRequestId: 'x', draft: false }, []],
        [{ kind: 'label', name: 'API', add: true }, [['POST', `${API}/issues/7/labels`, { labels: [5] }]]],
        [{ kind: 'label', name: 'api', add: false }, [['DELETE', `${API}/issues/7/labels/5`, undefined]]],
        [{ kind: 'reviewer', reviewer: { kind: 'user', login: 'kim' }, add: true }, [['POST', `${PULL}/requested_reviewers`, { reviewers: ['kim'] }]]],
        [{ kind: 'assignee', login: 'sam', add: true }, [['PATCH', PULL, { assignees: ['dana', 'sam'] }]]],
        [{ kind: 'assignee', login: 'DANA', add: false }, [['PATCH', PULL, { assignees: [] }]]]
    ])('changes a pull request: %o', async (change, expected) => {
        const { changes, service } = recordCalls({ [`${API}/issues/7/labels`]: undefined, [`${API}/issues/7/labels/5`]: undefined });
        await service.changePullRequest(REF, 7, change);
        expect(changes()).toEqual(expected);
    });

    it('does not offer auto-merge or a merge queue', async () => {
        const { service } = recordCalls();
        await expect(service.changePullRequest(REF, 7, { kind: 'autoMerge', pullRequestId: 'x', method: 'merge', headSha: SHA })).rejects.toThrow(
            'does not support auto-merge'
        );
    });

    it('sends a review with its line comments on the side of each comment', async () => {
        const { changes, service } = recordCalls({ [`${PULL}/reviews`]: () => ({ id: 106 }) });
        await service.submitReview(REF, 7, SHA, 'REQUEST_CHANGES', 'Please fix.', [
            { path: 'src/limits.ts', line: 2, side: 'RIGHT', body: 'Use a constant.' },
            { path: 'README.md', line: 3, side: 'LEFT', body: 'Keep this line.' }
        ]);
        expect(changes()).toEqual([
            [
                'POST',
                `${PULL}/reviews`,
                {
                    event: 'REQUEST_CHANGES',
                    body: 'Please fix.',
                    commit_id: SHA,
                    comments: [
                        { path: 'src/limits.ts', body: 'Use a constant.', new_position: 2 },
                        { path: 'README.md', body: 'Keep this line.', old_position: 3 }
                    ]
                }
            ]
        ]);
        await expect(service.submitReview(REF, 7, SHA, 'UNAPPROVE', '', [])).rejects.toThrow('do not accept the review');
    });

    it('replies with the replies API, else with a review comment on the line of the thread', async () => {
        const withApi = recordCalls({ [`${PULL}/comments/201/replies`]: { id: 204 } });
        await withApi.service.replyToComment(REF, 7, 201, 'Fixed.');
        expect(withApi.changes()).toEqual([['POST', `${PULL}/comments/201/replies`, { body: 'Fixed.' }]]);

        const without = recordCalls({
            [`${PULL}/comments/201/replies`]: notFound(),
            [`${PULL}/reviews`]: (method: string) => (method === 'GET' ? reviewsJson : { id: 107 })
        });
        await without.service.replyToComment(REF, 7, 201, 'Fixed.');
        expect(without.changes()).toEqual([
            ['POST', `${PULL}/comments/201/replies`, { body: 'Fixed.' }],
            ['POST', `${PULL}/reviews`, { event: 'COMMENT', body: '', commit_id: SHA, comments: [{ path: 'src/limits.ts', body: 'Fixed.', new_position: 4 }] }]
        ]);
    });

    it('resolves a thread by its first comment', async () => {
        const { changes, service } = recordCalls({ [`${API}/pulls/comments/201/resolve`]: undefined, [`${API}/pulls/comments/202/unresolve`]: notFound() });
        await service.setThreadResolved('gitea:git.example.com/acme/api/7/201', true);
        expect(changes()).toEqual([['POST', `${API}/pulls/comments/201/resolve`, undefined]]);
        await expect(service.setThreadResolved('gitea:git.example.com/acme/api/7/202', false)).rejects.toThrow('no API to resolve a conversation');
        await expect(service.setThreadResolved('gitea:codeberg.org/acme/api/7/202', false)).rejects.toThrow('not on git.example.com');
    });

    it('reads the workflows from the workflow folder that the server uses', async () => {
        const forgejo = recordCalls(
            {
                [`${API}/contents/.forgejo/workflows`]: notFound(),
                [`${API}/contents/.gitea/workflows`]: [
                    { name: 'ci.yml', path: '.gitea/workflows/ci.yml', type: 'file' },
                    { name: 'README.md', path: '.gitea/workflows/README.md', type: 'file' }
                ],
                [`${API}/raw/.gitea/workflows/ci.yml`]: 'on:\n  workflow_dispatch:\n    inputs:\n      level:\n        required: true\n'
            },
            '11.0.1+gitea-1.22.0'
        );
        const workflows = await forgejo.service.workflows(REF, 'main');
        expect(workflows).toEqual([
            {
                id: 1,
                name: 'ci.yml',
                path: '.gitea/workflows/ci.yml',
                dispatchable: true,
                inputs: [{ name: 'level', required: true, type: 'string' }]
            }
        ]);
        expect(forgejo.calls.map(([, url]) => url)).toContain(`${API}/contents/.forgejo/workflows?ref=main`);
    });

    it('starts a workflow by its file, and hides the action when the server has no dispatch API', async () => {
        const files = {
            [`${API}/contents/.gitea/workflows`]: [{ name: 'ci.yml', path: '.gitea/workflows/ci.yml', type: 'file' }],
            [`${API}/raw/.gitea/workflows/ci.yml`]: 'on: [push, workflow_dispatch]\n'
        };
        const ok = recordCalls({ ...files, [`${API}/actions/workflows/ci.yml/dispatches`]: undefined });
        const [workflow] = await ok.service.workflows(REF, 'main');
        await ok.service.dispatchWorkflow(REF, workflow.id, 'main', { level: '2' });
        expect(ok.changes()).toEqual([['POST', `${API}/actions/workflows/ci.yml/dispatches`, { ref: 'main', inputs: { level: '2' } }]]);

        const missing = recordCalls({ ...files, [`${API}/actions/workflows/ci.yml/dispatches`]: notFound() });
        const [before] = await missing.service.workflows(REF, 'main');
        expect(before.dispatchable).toBe(true);
        await expect(missing.service.dispatchWorkflow(REF, before.id, 'main')).rejects.toThrow('no API to start a workflow by hand');
        const [after] = await missing.service.workflows(REF, 'main');
        expect(after.dispatchable).toBe(false);
    });

    it('lists the open pull requests with the CI state of the newest runs', async () => {
        const { service } = recordCalls({ [`${API}/pulls`]: [pullRequestJson] });
        const queue = await service.repoPullRequests(REF);
        expect(queue.viewer).toBe('viewer');
        expect(queue.pullRequests[0]).toMatchObject({ number: 7, reviewRequested: true, checks: { state: 'FAILURE' } });
    });

    it('uploads screenshots as attachments and adds a comment with them', async () => {
        const { changes, service } = recordCalls({
            [`${API}/issues/7/assets`]: { browser_download_url: 'https://git.example.com/attachments/abc' },
            [`${API}/issues/7/comments`]: (method: string) =>
                method === 'GET' ? issueCommentsJson : { id: 303, html_url: 'https://git.example.com/acme/api/pulls/7#issuecomment-303' }
        });
        const url = await service.postScreenshots(REF, 7, [{ name: '01.png', data: Buffer.from('png') }], urls => `![shot](${urls[0]})`);
        expect(url).toBe('https://git.example.com/acme/api/pulls/7#issuecomment-303');
        expect(changes()).toEqual([
            ['POST', `${API}/issues/7/assets`, undefined],
            ['POST', `${API}/issues/7/comments`, { body: '![shot](https://git.example.com/attachments/abc)' }]
        ]);
    });
});
