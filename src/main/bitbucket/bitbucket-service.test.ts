import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { encodeBitbucketId } from '@shared/bitbucket';
import type { BitbucketClient } from './bitbucket-client';
import { BitbucketError } from './bitbucket-client';
import { BitbucketService, rerunTarget } from './bitbucket-service';
import branchJson from './fixtures/branch.json';
import commentsJson from './fixtures/comments.json';
import commitsJson from './fixtures/commits.json';
import diffstatJson from './fixtures/diffstat.json';
import pipelinesJson from './fixtures/pipelines.json';
import pullRequestJson from './fixtures/pull-request.json';
import pullRequestsJson from './fixtures/pull-requests.json';
import statusesJson from './fixtures/statuses.json';
import stepsJson from './fixtures/steps.json';

const ROOT = '/work/api';
const API = '/repositories/acme/api';
const PR = `${API}/pullrequests/17`;
const REF = { owner: 'acme', name: 'api', host: 'bitbucket' as const };
const REPO = { workspace: 'acme', repo: 'api' };
const diff = readFileSync(new URL('./fixtures/pull-request.diff', import.meta.url), 'utf8');
const VIEWER = { uuid: '{8c3e3f50-4d66-4f3e-9c98-3a3b8e3f2c03}', display_name: 'Viewer Person', nickname: 'viewer' };
const HEAD = '9f2c4e1b7a6d5c4b3a291807f6e5d4c3b2a19080';

/**
 * Records the requests of the service and gives fixed answers, without a network.
 * An answer matches when the path (without the query) is equal to its key. A key that ends with "?" matches the start.
 */
function recordCalls(answers: Record<string, unknown> = {}) {
    const calls: [string, string, unknown][] = [];
    const answer = (url: string) => {
        if (url === API) return { full_name: 'acme/api', slug: 'api', mainbranch: { name: 'main' } };
        if (url === '/user') return VIEWER;
        const path = url.replace(/\?.*$/, '');
        if (path in answers) return answers[path];
        for (const [key, value] of Object.entries(answers)) {
            if (key.endsWith('?') && url.startsWith(key)) return value;
        }
        return undefined;
    };
    const take = (url: string) => {
        const value = answer(url);
        if (value instanceof Error) throw value;
        return value;
    };
    const client = {
        request: async (method: string, url: string, body?: unknown) => {
            calls.push([method, url, body]);
            return take(url);
        },
        all: async (url: string) => {
            calls.push(['GET', url, undefined]);
            return take(url) ?? [];
        },
        text: async (url: string) => {
            calls.push(['GET', url, undefined]);
            return (take(url) as string | undefined) ?? '';
        }
    } as unknown as BitbucketClient;
    const service = new BitbucketService(client, async root =>
        root === ROOT ? 'git@bitbucket.org:acme/api.git' : root === '/work/github' ? 'git@github.com:acme/api.git' : ''
    );
    const changes = () => calls.filter(([method]) => method !== 'GET');
    return { calls, changes, service };
}

const PR_ANSWERS = {
    [PR]: pullRequestJson,
    [`${PR}/comments`]: commentsJson,
    [`${PR}/commits`]: commitsJson,
    [`${PR}/diffstat`]: diffstatJson,
    [`${PR}/diff`]: diff,
    [`${PR}/statuses`]: { values: statusesJson },
    [`${API}/refs/branches/main`]: branchJson
};

describe('BitbucketService', () => {
    it('owns only worktrees and references of Bitbucket', async () => {
        const { service } = recordCalls();
        expect(await service.owns(ROOT)).toBe(true);
        expect(await service.owns('/work/github')).toBe(false);
        expect(await service.owns(REF)).toBe(true);
        expect(await service.owns({ owner: 'acme', name: 'api' })).toBe(false);
    });

    it('loads a pull request with its comments, commits, diffstat, and merge strategies', async () => {
        const { calls, service } = recordCalls(PR_ANSWERS);
        const pr = await service.pullRequest(REF, 17);
        expect(pr).toMatchObject({ number: 17, headRefOid: HEAD, changedFiles: 4, checkCount: 3, defaultMergeMethod: 'squash' });
        expect(pr.threads).toHaveLength(2);
        expect(calls.map(([, url]) => url)).toContain(`${PR}/comments?pagelen=100`);
        expect(calls.map(([, url]) => url)).toContain(`${API}/refs/branches/main`);
    });

    it('loads the files of a pull request with their hunks', async () => {
        const { service } = recordCalls(PR_ANSWERS);
        const files = await service.pullRequestFiles(REF, 17);
        expect(files.map(file => file.path)).toEqual(['src/limits.ts', 'src/bucket.ts', 'docs/limits.md', 'src/legacy.ts']);
        expect(files[0].patch).toContain('+  burst: 10,');
        await service.setFileViewed(encodeBitbucketId(REPO, 17), 'src/bucket.ts', true);
        expect((await service.pullRequestFiles(REF, 17)).find(file => file.path === 'src/bucket.ts')?.viewed).toBe(true);
    });

    it('lists the pull requests that ask the viewer for a review, with a BBQL query', async () => {
        const { calls, service } = recordCalls({ [`${API}/pullrequests`]: { values: pullRequestsJson } });
        const rows = await service.pullRequests(REF, 'review');
        expect(rows.map(row => row.number)).toEqual([17]);
        const url = calls.find(([, path]) => path.startsWith(`${API}/pullrequests?`))![1];
        expect(decodeURIComponent(url)).toContain(`q=(state="OPEN") AND reviewers.uuid="${VIEWER.uuid}"`);
        expect(decodeURIComponent(url)).toContain('fields=+values.participants,+values.reviewers');
        expect(await service.pullRequests(REF, 'assigned')).toEqual([]);
    });

    it('reads the list again without the partial response when Bitbucket refuses it', async () => {
        let first = true;
        const { service, calls } = recordCalls();
        const list = { values: pullRequestsJson };
        (service as unknown as { client: { request: unknown } }).client.request = async (method: string, url: string) => {
            calls.push([method, url, undefined]);
            if (url === API) return { full_name: 'acme/api', mainbranch: { name: 'main' } };
            if (url === '/user') return VIEWER;
            if (url.includes('/pipelines/')) return { values: [] };
            if (first && url.includes('fields=')) {
                first = false;
                throw new BitbucketError('Bitbucket returned 400.', 400);
            }
            return list;
        };
        expect((await service.repoPullRequests(REF)).pullRequests).toHaveLength(3);
    });

    it('sends a review with inline comments, a comment, and an approval', async () => {
        const { changes, service } = recordCalls();
        await service.submitReview(REF, 17, HEAD, 'APPROVE', 'Looks good.', [
            { path: 'src/limits.ts', line: 12, side: 'RIGHT', body: 'Nice.' },
            { path: 'src/server.ts', line: 7, startLine: 5, side: 'LEFT', body: 'Why?' }
        ]);
        expect(changes()).toEqual([
            ['POST', `${PR}/comments`, { content: { raw: 'Nice.' }, inline: { path: 'src/limits.ts', to: 12 } }],
            ['POST', `${PR}/comments`, { content: { raw: 'Why?' }, inline: { path: 'src/server.ts', from: 7, start_from: 5 } }],
            ['POST', `${PR}/comments`, { content: { raw: 'Looks good.' } }],
            ['POST', `${PR}/approve`, undefined]
        ]);
    });

    it('removes an approval and requests changes', async () => {
        const { changes, service } = recordCalls();
        await service.submitReview(REF, 17, HEAD, 'UNAPPROVE', '', []);
        await service.submitReview(REF, 17, HEAD, 'REQUEST_CHANGES', '', []);
        expect(changes()).toEqual([
            ['DELETE', `${PR}/approve`, undefined],
            ['POST', `${PR}/request-changes`, undefined]
        ]);
    });

    it('replies to a thread, and resolves and opens a thread', async () => {
        const { changes, service } = recordCalls();
        await service.replyToComment(REF, 17, 501, 'Fixed.');
        await service.setThreadResolved(encodeBitbucketId(REPO, 17, 501), true);
        await service.setThreadResolved(encodeBitbucketId(REPO, 17, 501), false);
        expect(changes()).toEqual([
            ['POST', `${PR}/comments`, { content: { raw: 'Fixed.' }, parent: { id: 501 } }],
            ['POST', `${PR}/comments/501/resolve`, undefined],
            ['DELETE', `${PR}/comments/501/resolve`, undefined]
        ]);
        await expect(service.setThreadResolved(encodeBitbucketId(REPO, 17), true)).rejects.toThrow('not a Bitbucket thread ID');
    });

    it('merges with the strategy of the branch, and refuses a merge after a new push', async () => {
        const { changes, service } = recordCalls(PR_ANSWERS);
        await service.merge(REF, 17, HEAD, 'squash');
        await service.merge(REF, 17, HEAD, 'rebase');
        expect(changes()).toEqual([
            ['POST', `${PR}/merge`, { type: 'pullrequest', merge_strategy: 'squash', close_source_branch: true }],
            ['POST', `${PR}/merge`, { type: 'pullrequest', merge_strategy: 'fast_forward', close_source_branch: true }]
        ]);
        await expect(service.merge(REF, 17, 'ffffffffffffffffffffffffffffffffffffffff', 'merge')).rejects.toThrow('The branch has new commits');
    });

    it('changes the base, the draft state, the reviewers, and declines, and keeps the reviewers in each update', async () => {
        const { changes, service } = recordCalls(PR_ANSWERS);
        const reviewers = [{ uuid: '{7b2d2e4f-3c55-4e2d-8b87-2f2a7d2e1b02}' }, { uuid: VIEWER.uuid }];
        const title = 'Add rate limits to the public API';
        await service.pullRequest(REF, 17);
        await service.changePullRequest(REF, 17, { kind: 'base', base: 'release/2.0' });
        await service.changePullRequest(REF, 17, { kind: 'draft', pullRequestId: 'x', draft: true });
        await service.changePullRequest(REF, 17, { kind: 'reviewer', reviewer: { kind: 'user', login: 'sam' }, add: true });
        await service.changePullRequest(REF, 17, { kind: 'reviewer', reviewer: { kind: 'user', login: 'lee' }, add: false });
        await service.changePullRequest(REF, 17, { kind: 'details', title: 'New title', state: 'closed' });
        expect(changes()).toEqual([
            ['PUT', PR, { title, reviewers, destination: { branch: { name: 'release/2.0' } } }],
            ['PUT', PR, { title, reviewers, draft: true }],
            ['PUT', PR, { title, reviewers: [...reviewers, { uuid: '{9d4f4061-5e77-4a4f-8da9-4b4c9f403d04}' }] }],
            ['PUT', PR, { title, reviewers: [{ uuid: VIEWER.uuid }] }],
            ['PUT', PR, { title: 'New title', reviewers }],
            ['POST', `${PR}/decline`, undefined]
        ]);
        await expect(service.changePullRequest(REF, 17, { kind: 'details', state: 'open' })).rejects.toThrow('cannot open a declined pull request');
        await expect(service.changePullRequest(REF, 17, { kind: 'label', name: 'x', add: true })).rejects.toThrow('no labels');
    });

    it('shows the steps of the newest pipeline and the statuses of other CI services as checks', async () => {
        const pipelineApi = `${API}/pipelines/${encodeURIComponent('{a0000000-0000-0000-0000-000000000042}')}`;
        const { calls, changes, service } = recordCalls({
            [`${API}/commit/${HEAD}/statuses`]: statusesJson,
            [`${API}/pipelines/`]: { values: pipelinesJson },
            [`${pipelineApi}/steps/`]: stepsJson,
            [pipelineApi]: pipelinesJson[0],
            [`${pipelineApi}/steps/${encodeURIComponent('{b0000000-0000-0000-0000-000000000002}')}/log`]: '\x1b[31mFAIL\x1b[0m limits.test.ts\n'
        });
        const checks = await service.checks(REF, HEAD);
        expect(checks.map(check => check.name)).toEqual(['Lint', 'Unit tests', 'Deploy to staging', 'SonarCloud', 'jenkins-e2e']);
        const failed = checks[1];
        expect(await service.jobLog(REF, failed.id)).toBe('FAIL limits.test.ts\n');
        await service.rerunJob(REF, failed.id);
        await service.cancelRun(REF, failed.runId!);
        expect(changes()).toEqual([
            ['POST', `${API}/pipelines/`, { target: rerunTarget(pipelinesJson[0].target) }],
            ['POST', `${pipelineApi}/stopPipeline`, undefined]
        ]);
        expect(calls.some(([, url]) => url.includes('/steps/') && url.endsWith('/log'))).toBe(true);
        await expect(service.jobLog(REF, 9999)).rejects.toThrow('Load the checks again');
    });

    it('builds the target of a new run from a pipeline', () => {
        expect(rerunTarget(pipelinesJson[0].target)).toEqual({
            type: 'pipeline_pullrequest_target',
            selector: { type: 'pull-requests', pattern: '**' },
            commit: { type: 'commit', hash: HEAD },
            source: 'feature/rate-limits',
            destination: 'main',
            destination_commit: { hash: '3b5d7f9a1c2e' },
            pullrequest: { id: 17 }
        });
        expect(rerunTarget(pipelinesJson[1].target)).toMatchObject({ type: 'pipeline_ref_target', ref_type: 'branch', ref_name: 'main' });
        expect(() => rerunTarget(undefined)).toThrow('no target');
    });

    it('starts a pipeline on a branch with variables, and lists the pipelines as runs', async () => {
        const { changes, service } = recordCalls({ [`${API}/pipelines/`]: { values: pipelinesJson } });
        await service.dispatchWorkflow(REF, 1, 'main', { DEPLOY: 'yes' });
        expect(changes()).toEqual([
            [
                'POST',
                `${API}/pipelines/`,
                { target: { type: 'pipeline_ref_target', ref_type: 'branch', ref_name: 'main' }, variables: [{ key: 'DEPLOY', value: 'yes' }] }
            ]
        ]);
        const runs = await service.workflowRuns(REF);
        expect(runs.map(run => run.runNumber)).toEqual([42, 41, 40]);
    });

    it('lists the repositories of the workspaces of the user', async () => {
        const { calls, service } = recordCalls({
            '/user/workspaces': [{ workspace: { slug: 'acme' } }, { slug: 'dana' }],
            '/repositories/acme': [{ full_name: 'acme/api', slug: 'api', updated_on: '2026-11-18T00:00:00Z' }],
            '/repositories/dana': [{ full_name: 'dana/dotfiles', slug: 'dotfiles' }]
        });
        expect(await service.repositories(undefined)).toEqual([
            { owner: 'acme', name: 'api', host: 'bitbucket', pushedAt: '2026-11-18T00:00:00Z' },
            { owner: 'dana', name: 'dotfiles', host: 'bitbucket' }
        ]);
        expect(calls.map(([, url]) => url)).toContain('/repositories/acme?role=member&sort=-updated_on&pagelen=100');
    });
});
