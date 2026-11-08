import { describe, expect, it } from 'vitest';
import { canManagePullRequests, canMergePullRequests, type PullRequestChange } from '@shared/github';
import type { GitHubClient } from './github-client';
import { GitHubService } from './github-service';

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
