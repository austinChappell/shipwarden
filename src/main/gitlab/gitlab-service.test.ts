import { describe, expect, it } from 'vitest';
import { encodeGitLabId } from '@shared/gitlab';
import type { PullRequestChange } from '@shared/github';
import type { GitLabClient } from './gitlab-client';
import { GitLabError } from './gitlab-client';
import { GitLabService } from './gitlab-service';
import approvalsJson from './fixtures/approvals.json';
import commitsJson from './fixtures/commits.json';
import diffsJson from './fixtures/diffs.json';
import discussionsJson from './fixtures/discussions.json';
import jobsJson from './fixtures/jobs.json';
import mergeRequestJson from './fixtures/merge-request.json';
import pipelinesJson from './fixtures/pipelines.json';

const ROOT = '/work/api';
const API = '/projects/acme%2Fplatform%2Fapi';
const MR = `${API}/merge_requests/42`;
const REF = { owner: 'gitlab.com/acme/platform', name: 'api', host: 'gitlab' as const };
const REPO = { host: 'gitlab.com', namespace: 'acme/platform', project: 'api' };

/** Records the requests of the service and gives fixed answers, without a network. */
function recordCalls(answers: Record<string, unknown> = {}, host = 'gitlab.com') {
    const calls: [string, string, unknown][] = [];
    const answer = (url: string) => {
        if (url === API) return { id: 3471, path_with_namespace: 'acme/platform/api', default_branch: 'main', squash_option: 'default_off' };
        if (url === '/user') return { id: 303, username: 'viewer' };
        for (const [key, value] of Object.entries(answers)) {
            if (url.includes(key)) return value;
        }
        return undefined;
    };
    const client = {
        host: () => host,
        baseUrl: () => `https://${host}`,
        request: async (method: string, url: string, body?: unknown) => {
            calls.push([method, url, body]);
            const value = answer(url);
            if (value instanceof Error) throw value;
            return value;
        },
        all: async (url: string) => {
            calls.push(['GET', url, undefined]);
            const value = answer(url);
            if (value instanceof Error) throw value;
            return value ?? [];
        },
        text: async (url: string) => {
            calls.push(['GET', url, undefined]);
            return 'section_start:1:step\r\x1b[0K\x1b[32mok\x1b[0m\n';
        }
    } as unknown as GitLabClient;
    const service = new GitLabService(client, async root =>
        root === ROOT ? 'git@gitlab.com:acme/platform/api.git' : root === '/work/self' ? 'git@git.example.com:team/web.git' : 'git@github.com:acme/api.git'
    );
    const changes = () => calls.filter(([method]) => method !== 'GET');
    return { calls, changes, service };
}

describe('GitLabService', () => {
    it('owns only worktrees and references of its server', async () => {
        const { service } = recordCalls();
        expect(await service.owns(ROOT)).toBe(true);
        expect(await service.owns('/work/self')).toBe(false);
        expect(await service.owns('/work/github')).toBe(false);
        expect(await service.owns(REF)).toBe(true);
        expect(await service.owns({ owner: 'git.example.com/team', name: 'web', host: 'gitlab' })).toBe(false);
        expect(await service.owns({ owner: 'acme', name: 'api' })).toBe(false);
    });

    it('loads a merge request with its approvals, discussions, and commits', async () => {
        const { calls, service } = recordCalls({
            [`${MR}/approvals`]: approvalsJson,
            [`${MR}/discussions`]: discussionsJson,
            [`${MR}/commits`]: commitsJson,
            [`${API}/labels`]: [{ name: 'api', color: '#428BCA', description: 'API work' }],
            [MR]: mergeRequestJson
        });
        const pr = await service.pullRequest(REF, 42);
        expect(pr.title).toBe('Draft: Add rate limits to the public API');
        expect(pr.threads).toHaveLength(2);
        expect(pr.labels).toEqual([
            { name: 'backend', color: '8b949e' },
            { name: 'api', color: '428BCA', description: 'API work' }
        ]);
        expect(pr.checkCount).toBe(1);
        expect(calls.map(([, url]) => url)).toEqual(expect.arrayContaining([API, MR, `${MR}/approvals`, `${MR}/discussions`, `${MR}/commits`, '/user']));
    });

    it('sends diff comments with the base, start, and head commits, then the body and the approval', async () => {
        const { changes, service } = recordCalls({ [`${MR}/diffs`]: diffsJson, [MR]: mergeRequestJson });
        await service.submitReview(ROOT, 42, '9f2c1e7a4b5d6c8e0f1a2b3c4d5e6f708192a3b4', 'APPROVE', 'Looks good.', [
            { path: 'src/limits.ts', line: 12, side: 'RIGHT', body: 'Rename this.' },
            { path: 'src/limits.ts', line: 9, side: 'RIGHT', body: 'Context line.' },
            { path: 'src/constants.ts', line: 1, side: 'LEFT', body: 'Why?' }
        ]);
        const refs = {
            position_type: 'text',
            base_sha: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
            start_sha: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
            head_sha: '9f2c1e7a4b5d6c8e0f1a2b3c4d5e6f708192a3b4'
        };
        expect(changes()).toEqual([
            ['POST', `${MR}/discussions`, { body: 'Rename this.', position: { ...refs, old_path: 'src/limits.ts', new_path: 'src/limits.ts', new_line: 12 } }],
            [
                'POST',
                `${MR}/discussions`,
                { body: 'Context line.', position: { ...refs, old_path: 'src/limits.ts', new_path: 'src/limits.ts', old_line: 9, new_line: 9 } }
            ],
            ['POST', `${MR}/discussions`, { body: 'Why?', position: { ...refs, old_path: 'src/constants.ts', new_path: 'src/constants.ts', old_line: 1 } }],
            ['POST', `${MR}/notes`, { body: 'Looks good.' }],
            ['POST', `${MR}/approve`, { sha: '9f2c1e7a4b5d6c8e0f1a2b3c4d5e6f708192a3b4' }]
        ]);
    });

    it('revokes an approval', async () => {
        const { changes, service } = recordCalls();
        await service.submitReview(REF, 42, 'abc', 'UNAPPROVE', '', []);
        expect(changes()).toEqual([['POST', `${MR}/unapprove`, undefined]]);
    });

    it('replies to the discussion of a note, and loads the discussions when the note is not known', async () => {
        const { calls, changes, service } = recordCalls({ [`${MR}/discussions`]: discussionsJson });
        await service.replyToComment(REF, 42, 1126, 'Done.');
        await service.replyToComment(REF, 42, 1126, 'Again.');
        expect(changes()).toEqual([
            ['POST', `${MR}/discussions/6a9c1750b37d513a43987b574953fceb50b03ce7/notes`, { body: 'Done.' }],
            ['POST', `${MR}/discussions/6a9c1750b37d513a43987b574953fceb50b03ce7/notes`, { body: 'Again.' }]
        ]);
        // The second reply finds the discussion without a new request.
        expect(calls.filter(([, url]) => url === `${MR}/discussions`)).toHaveLength(1);
        await expect(service.replyToComment(REF, 42, 9999, 'x')).rejects.toThrow(/does not exist/);
    });

    it('resolves and unresolves a thread from its ID', async () => {
        const { changes, service } = recordCalls();
        const id = encodeGitLabId(REPO, 42, '6a9c1750');
        await service.setThreadResolved(id, true);
        await service.setThreadResolved(id, false);
        expect(changes()).toEqual([
            ['PUT', `${MR}/discussions/6a9c1750?resolved=true`, undefined],
            ['PUT', `${MR}/discussions/6a9c1750?resolved=false`, undefined]
        ]);
        await expect(service.setThreadResolved(encodeGitLabId({ ...REPO, host: 'git.example.com' }, 42, 'x'), true)).rejects.toThrow(/not on gitlab\.com/);
    });

    it('merges with the head commit and the squash choice', async () => {
        const { changes, service } = recordCalls();
        await service.merge(REF, 42, 'abc123', 'squash');
        await service.merge(REF, 42, 'abc123', 'merge');
        expect(changes()).toEqual([
            ['PUT', `${MR}/merge`, { sha: 'abc123', squash: true }],
            ['PUT', `${MR}/merge`, { sha: 'abc123', squash: false }]
        ]);
    });

    it('changes the base, the details, the draft state, the labels, the reviewers, and the auto-merge', async () => {
        const { changes, service } = recordCalls({
            [MR]: mergeRequestJson,
            '/users?username=sam': [{ id: 404, username: 'sam' }],
            '/users?username=dana': [{ id: 101, username: 'dana' }]
        });
        const run = (change: PullRequestChange) => service.changePullRequest(REF, 42, change);
        await run({ kind: 'base', base: 'release/2.0' });
        await run({ kind: 'details', title: 'New title', state: 'closed' });
        await run({ kind: 'draft', pullRequestId: 'x', draft: false });
        await run({ kind: 'label', name: 'api', add: false });
        await run({ kind: 'reviewer', reviewer: { kind: 'user', login: 'sam' }, add: true });
        await run({ kind: 'assignee', login: 'dana', add: false });
        await run({ kind: 'autoMerge', pullRequestId: 'x', method: 'merge', headSha: 'abc' });
        await run({ kind: 'autoMerge', pullRequestId: 'x', method: null, headSha: 'abc' });
        expect(changes()).toEqual([
            ['PUT', MR, { target_branch: 'release/2.0' }],
            ['PUT', MR, { title: 'New title', state_event: 'close' }],
            ['PUT', MR, { title: 'Add rate limits to the public API' }],
            ['PUT', MR, { remove_labels: 'api' }],
            ['PUT', MR, { reviewer_ids: [202, 303, 404] }],
            ['PUT', MR, { assignee_ids: [] }],
            ['PUT', `${MR}/merge`, { auto_merge: true, merge_when_pipeline_succeeds: true, squash: false, sha: 'abc' }],
            ['POST', `${MR}/cancel_merge_when_pipeline_succeeds`, undefined]
        ]);
    });

    it('gives the jobs of the newest pipeline of a commit as checks', async () => {
        const { calls, service } = recordCalls({ [`${API}/pipelines/99012/jobs`]: jobsJson, [`${API}/pipelines?sha=`]: [pipelinesJson[0]] });
        const checks = await service.checks(REF, '9f2c1e7a4b5d6c8e0f1a2b3c4d5e6f708192a3b4');
        expect(checks.map(check => check.id)).toEqual([7731003, 7731004, 7731005, 7731006, 7731007]);
        expect(calls.some(([, url]) => url.startsWith(`${API}/pipelines?sha=9f2c1e7a`))).toBe(true);
    });

    it('gives no checks for a commit without a pipeline', async () => {
        const { service } = recordCalls({ [`${API}/pipelines?sha=`]: [] });
        expect(await service.checks(REF, 'abc')).toEqual([]);
    });

    it('reads a job log, and retries a job and a pipeline', async () => {
        const { changes, service } = recordCalls();
        expect(await service.jobLog(REF, 7731004)).toBe('ok\n');
        await service.rerunJob(REF, 7731004);
        await service.rerunFailedJobs(REF, 99012);
        await service.cancelRun(REF, 99012);
        expect(changes()).toEqual([
            ['POST', `${API}/jobs/7731004/retry`, undefined],
            ['POST', `${API}/pipelines/99012/retry`, undefined],
            ['POST', `${API}/pipelines/99012/cancel`, undefined]
        ]);
    });

    it('starts a pipeline with variables', async () => {
        const { changes, service } = recordCalls();
        await service.dispatchWorkflow(REF, 1, 'main', { DEPLOY: 'yes' });
        expect(changes()).toEqual([['POST', `${API}/pipeline`, { ref: 'main', variables: [{ key: 'DEPLOY', value: 'yes' }] }]]);
    });

    it('falls back to the changes API on a server without the diffs API', async () => {
        const { service } = recordCalls({ [`${MR}/diffs`]: new GitLabError('not found', 404), [`${MR}/changes`]: { changes: diffsJson } });
        const files = await service.pullRequestFiles(REF, 42);
        expect(files.map(file => file.path)).toEqual(['src/limits.ts', 'src/bucket.ts', 'src/rate.ts', 'src/constants.ts']);
    });

    it('keeps the viewed files of a merge request in memory', async () => {
        const { service } = recordCalls({ [`${MR}/diffs`]: diffsJson });
        await service.setFileViewed(encodeGitLabId(REPO, 42), 'src/bucket.ts', true);
        const files = await service.pullRequestFiles(REF, 42);
        expect(files.filter(file => file.viewed).map(file => file.path)).toEqual(['src/bucket.ts']);
    });

    it('lists the branches with the default branch first', async () => {
        const { service } = recordCalls({ [`${API}/repository/branches`]: [{ name: 'feature/a' }, { name: 'main' }] });
        expect(await service.branches(REF)).toEqual(['main', 'feature/a']);
    });

    it('keeps the projects of the scope in the repository list', async () => {
        const { service } = recordCalls({
            '/projects?membership=true': [
                { id: 1, path_with_namespace: 'acme/platform/api', last_activity_at: '2026-11-14T00:00:00Z' },
                { id: 2, path_with_namespace: 'other/site', last_activity_at: '2026-11-13T00:00:00Z' }
            ]
        });
        expect(await service.repositories(['acme'])).toEqual([{ ...REF, pushedAt: '2026-11-14T00:00:00Z' }]);
        expect(await service.repositories(undefined)).toHaveLength(2);
    });
});
