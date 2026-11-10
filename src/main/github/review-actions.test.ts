import { describe, expect, it } from 'vitest';
import type { MergeMethod, PendingComment, ReviewEvent } from '@shared/github';
import { GitHubError } from './github-client';
import { fakeClient } from './fake-client';
import { changePullRequest, merge, replyToComment, reviewBody, setFileViewed, setThreadResolved, submitReview } from './review-actions';

const repo = { owner: 'acme', name: 'api' };

const pending: PendingComment[] = [
    { path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'Use a constant.' },
    { path: 'src/b.ts', line: 3, side: 'LEFT', body: 'Why remove this?', fromAgent: true, needsDecision: false }
];

describe('reviewBody', () => {
    it('removes an empty text from the body', () => {
        expect(reviewBody('abc', 'APPROVE', '', [])).toEqual({ commit_id: 'abc', event: 'APPROVE', body: undefined, comments: [] });
    });

    it('keeps only the path, the line, the side and the text of each line comment', () => {
        expect(reviewBody('abc', 'COMMENT', 'Notes', pending).comments).toEqual([
            { path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'Use a constant.' },
            { path: 'src/b.ts', line: 3, side: 'LEFT', body: 'Why remove this?' }
        ]);
    });
});

describe('submitReview', () => {
    const events: ReviewEvent[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];

    it.each(events)('sends one review request for the %s event', async event => {
        const { client, calls } = fakeClient();
        await submitReview(client, repo, 7, 'head1', event, 'The text', []);
        expect(calls).toEqual([
            {
                kind: 'rest',
                method: 'POST',
                path: '/repos/acme/api/pulls/7/reviews',
                body: { commit_id: 'head1', event, body: 'The text', comments: [] }
            }
        ]);
    });

    it('sends the pending line comments in the same request', async () => {
        const { client, calls } = fakeClient();
        await submitReview(client, repo, 7, 'head1', 'REQUEST_CHANGES', '', pending);
        expect(calls).toHaveLength(1);
        expect(calls[0].body).toEqual({
            commit_id: 'head1',
            event: 'REQUEST_CHANGES',
            body: undefined,
            comments: [
                { path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'Use a constant.' },
                { path: 'src/b.ts', line: 3, side: 'LEFT', body: 'Why remove this?' }
            ]
        });
    });

    it('gives the GitHub error to the caller', async () => {
        const { client } = fakeClient(() => {
            throw new GitHubError('GitHub returned 422.', 422);
        });
        await expect(submitReview(client, repo, 7, 'head1', 'APPROVE', '', [])).rejects.toMatchObject({ status: 422 });
    });
});

describe('replyToComment', () => {
    it('sends the reply to the replies endpoint of the comment', async () => {
        const { client, calls } = fakeClient();
        await replyToComment(client, repo, 7, 991, 'Done.');
        expect(calls).toEqual([{ kind: 'rest', method: 'POST', path: '/repos/acme/api/pulls/7/comments/991/replies', body: { body: 'Done.' } }]);
    });
});

describe('setThreadResolved', () => {
    it('sends the resolve mutation or the unresolve mutation', async () => {
        const { client, calls } = fakeClient();
        await setThreadResolved(client, 'T1', true);
        await setThreadResolved(client, 'T1', false);
        expect(calls.map(call => call.path.match(/\{ (\w+)\(/)?.[1])).toEqual(['resolveReviewThread', 'unresolveReviewThread']);
        expect(calls.map(call => call.body)).toEqual([{ id: 'T1' }, { id: 'T1' }]);
    });
});

describe('setFileViewed', () => {
    it('sends the mark mutation or the unmark mutation with the path', async () => {
        const { client, calls } = fakeClient();
        await setFileViewed(client, 'PR1', 'src/a.ts', true);
        await setFileViewed(client, 'PR1', 'src/a.ts', false);
        expect(calls[0].path).toContain('markFileAsViewed(');
        expect(calls[0].path).not.toContain('unmarkFileAsViewed');
        expect(calls[1].path).toContain('unmarkFileAsViewed(');
        expect(calls.map(call => call.body)).toEqual([
            { id: 'PR1', path: 'src/a.ts' },
            { id: 'PR1', path: 'src/a.ts' }
        ]);
    });
});

describe('merge', () => {
    const methods: MergeMethod[] = ['merge', 'squash', 'rebase'];

    it.each(methods)('sends the %s method and the head commit', async method => {
        const { client, calls } = fakeClient();
        await merge(client, repo, 7, 'head1', method);
        expect(calls).toEqual([{ kind: 'rest', method: 'PUT', path: '/repos/acme/api/pulls/7/merge', body: { merge_method: method, sha: 'head1' } }]);
    });

    it.each([
        [405, 'GitHub returned 405 for PUT /repos/acme/api/pulls/7/merge. Pull Request is not mergeable'],
        [409, 'GitHub returned 409 for PUT /repos/acme/api/pulls/7/merge. Head branch was modified.'],
        [403, 'GitHub returned 403 for PUT /repos/acme/api/pulls/7/merge. Resource not accessible by integration']
    ])('gives the %i error of GitHub to the caller', async (status, message) => {
        const { client } = fakeClient(() => Promise.reject(new GitHubError(message, status)));
        const result = merge(client, repo, 7, 'head1', 'squash');
        await expect(result).rejects.toBeInstanceOf(GitHubError);
        await expect(result).rejects.toMatchObject({ status, message });
    });
});

describe('changePullRequest with GraphQL', () => {
    it('makes a pull request a draft or ready for review', async () => {
        const { client, calls } = fakeClient();
        await changePullRequest(client, repo, 7, { kind: 'draft', pullRequestId: 'PR1', draft: true });
        await changePullRequest(client, repo, 7, { kind: 'draft', pullRequestId: 'PR1', draft: false });
        expect(calls[0].path).toContain('convertPullRequestToDraft');
        expect(calls[1].path).toContain('markPullRequestReadyForReview');
        expect(calls.every(call => call.kind === 'graphql')).toBe(true);
    });

    it('turns on auto-merge with the method in capital letters and the head commit', async () => {
        const { client, calls } = fakeClient();
        await changePullRequest(client, repo, 7, { kind: 'autoMerge', pullRequestId: 'PR1', method: 'squash', headSha: 'head1' });
        expect(calls[0].path).toContain('enablePullRequestAutoMerge');
        expect(calls[0].body).toEqual({ id: 'PR1', method: 'SQUASH', head: 'head1' });
    });

    it('turns off auto-merge when the change has no method', async () => {
        const { client, calls } = fakeClient();
        await changePullRequest(client, repo, 7, { kind: 'autoMerge', pullRequestId: 'PR1', method: null, headSha: 'head1' });
        expect(calls[0].path).toContain('disablePullRequestAutoMerge');
        expect(calls[0].body).toEqual({ id: 'PR1' });
    });
});
