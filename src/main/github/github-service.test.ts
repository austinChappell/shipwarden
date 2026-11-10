import { describe, expect, it } from 'vitest';
import { canManagePullRequests, canMergePullRequests, type PullRequestChange } from '@shared/github';
import { GitHubError, type GitHubClient } from './github-client';
import { fakeClient, graphQlPullRequest, queryHas } from './fake-client';
import { GitHubService, githubViewerRole } from './github-service';

/** Records the REST calls of the service, without a network. */
function recordCalls() {
    const calls: [string, string, unknown][] = [];
    const client = { rest: async (method: string, path: string, body?: unknown) => { calls.push([method, path, body]); } } as unknown as GitHubClient;
    return { calls, service: new GitHubService(client) };
}

const repo = { owner: 'acme', name: 'api' };

describe('changePullRequest', () => {
    const cases: [PullRequestChange, [string, string, unknown]][] = [
        [{ kind: 'details', body: 'New text' }, ['PATCH', '/repos/acme/api/pulls/7', { title: undefined, body: 'New text', state: undefined }]],
        [{ kind: 'details', state: 'closed' }, ['PATCH', '/repos/acme/api/pulls/7', { title: undefined, body: undefined, state: 'closed' }]],
        [{ kind: 'assignee', login: 'ana', add: true }, ['POST', '/repos/acme/api/issues/7/assignees', { assignees: ['ana'] }]],
        [{ kind: 'assignee', login: 'ana', add: false }, ['DELETE', '/repos/acme/api/issues/7/assignees', { assignees: ['ana'] }]],
        [{ kind: 'reviewer', reviewer: { kind: 'user', login: 'bo' }, add: true }, ['POST', '/repos/acme/api/pulls/7/requested_reviewers', { reviewers: ['bo'] }]],
        [{ kind: 'reviewer', reviewer: { kind: 'team', login: 'platform' }, add: false }, ['DELETE', '/repos/acme/api/pulls/7/requested_reviewers', { team_reviewers: ['platform'] }]],
        [{ kind: 'label', name: 'bug', add: true }, ['POST', '/repos/acme/api/issues/7/labels', { labels: ['bug'] }]],
        [{ kind: 'label', name: 'needs review', add: false }, ['DELETE', '/repos/acme/api/issues/7/labels/needs%20review', undefined]]
    ];
    it.each(cases)('sends the correct request for %j', async (change, expected) => {
        const { calls, service } = recordCalls();
        await service.changePullRequest(repo, 7, change);
        expect(calls).toEqual([expected]);
    });
});

describe('canManagePullRequests', () => {
    it('lets triage access and more change the assignees, the reviewers and the labels', () => {
        expect(['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE'].map(canManagePullRequests)).toEqual([true, true, true, true]);
        expect(canManagePullRequests('READ')).toBe(false);
        expect(canManagePullRequests(null)).toBe(false);
    });
});

describe('canMergePullRequests', () => {
    it('lets write access and more merge a pull request', () => {
        expect(['ADMIN', 'MAINTAIN', 'WRITE'].map(canMergePullRequests)).toEqual([true, true, true]);
        expect(canMergePullRequests('TRIAGE')).toBe(false);
        expect(canMergePullRequests('READ')).toBe(false);
        expect(canMergePullRequests(null)).toBe(false);
    });
});

describe('githubViewerRole', () => {
    const pr = (change: Partial<Parameters<typeof githubViewerRole>[1]> = {}) => ({
        viewerDidAuthor: false,
        assignees: { nodes: [] },
        reviewRequests: { nodes: [] },
        participants: { nodes: [{ login: 'octocat' }] },
        ...change
    });

    it('finds the author, the involved users and the other users', () => {
        expect(githubViewerRole('me', pr({ viewerDidAuthor: true }))).toBe('author');
        expect(githubViewerRole('me', pr({ assignees: { nodes: [{ login: 'me' }] } }))).toBe('involved');
        expect(githubViewerRole('me', pr({ reviewRequests: { nodes: [{ requestedReviewer: { login: 'me' } }, { requestedReviewer: {} }] } }))).toBe('involved');
        expect(githubViewerRole('me', pr({ participants: { nodes: [{ login: 'me' }] } }))).toBe('involved');
        expect(githubViewerRole('me', pr())).toBeUndefined();
    });
});

describe('GitHubService delegation', () => {
    it('sends the review, the merge and the re-runs to GitHub with the same requests as before', async () => {
        const { client, calls } = fakeClient();
        const service = new GitHubService(client);
        await service.submitReview(repo, 7, 'head1', 'APPROVE', '', [{ path: 'a.ts', line: 2, side: 'RIGHT', body: 'Nice.' }]);
        await service.merge(repo, 7, 'head1', 'rebase');
        await service.rerunJob(repo, 31);
        await service.rerunFailedJobs(repo, 900);
        await service.rerunRun(repo, 900);
        await service.cancelRun(repo, 900);
        await service.replyToComment(repo, 7, 101, 'Fixed.');
        expect(calls.map(call => [call.method, call.path])).toEqual([
            ['POST', '/repos/acme/api/pulls/7/reviews'],
            ['PUT', '/repos/acme/api/pulls/7/merge'],
            ['POST', '/repos/acme/api/actions/jobs/31/rerun'],
            ['POST', '/repos/acme/api/actions/runs/900/rerun-failed-jobs'],
            ['POST', '/repos/acme/api/actions/runs/900/rerun'],
            ['POST', '/repos/acme/api/actions/runs/900/cancel'],
            ['POST', '/repos/acme/api/pulls/7/comments/101/replies']
        ]);
        expect(calls[0].body).toEqual({ commit_id: 'head1', event: 'APPROVE', body: undefined, comments: [{ path: 'a.ts', line: 2, side: 'RIGHT', body: 'Nice.' }] });
        expect(calls[1].body).toEqual({ merge_method: 'rebase', sha: 'head1' });
    });

    it('gives a merge error of GitHub to the caller', async () => {
        const { client } = fakeClient(() => Promise.reject(new GitHubError('GitHub returned 405.', 405)));
        await expect(new GitHubService(client).merge(repo, 7, 'head1', 'merge')).rejects.toMatchObject({ status: 405 });
    });

    it('returns the clean job log and the mapped checks', async () => {
        const { client } = fakeClient(call => {
            if (call.kind === 'text') return '2026-11-09T10:00:00Z FAIL';
            if (call.kind === 'paginate') return { check_runs: [] };
            return { statuses: [{ id: 1, context: 'ci', state: 'failure', target_url: 't', created_at: 'c', updated_at: 'u' }] };
        });
        const service = new GitHubService(client);
        expect(await service.jobLog(repo, 31)).toBe('FAIL');
        expect(await service.checks(repo, 'sha1')).toEqual([
            { id: 1, name: 'ci', status: 'completed', conclusion: 'failure', startedAt: 'c', completedAt: 'u', url: 't', isActions: false, isStatus: true }
        ]);
    });

    it('returns the pull request from the GraphQL data', async () => {
        const { client } = fakeClient(call => queryHas(call, 'timelineItems') ? { repository: { pullRequest: null } } : graphQlPullRequest());
        const pr = await new GitHubService(client).pullRequest(repo, 7);
        expect([pr.number, pr.headRefOid, pr.timeline]).toEqual([7, 'head1', []]);
    });
});
