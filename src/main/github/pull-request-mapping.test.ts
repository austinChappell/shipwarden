import { describe, expect, it } from 'vitest';
import {
    allowedMergeMethods,
    mapBranchSummaries,
    mapPullRequest,
    mapPullRequestSummaries,
    mapReactions,
    mapReviewRequests,
    type GraphQlBranchPullRequest
} from './pull-request-mapping';
import { graphQlPullRequest } from './fake-client';

const repo = { owner: 'acme', name: 'api' };

describe('allowedMergeMethods', () => {
    it('lists the allowed methods in the order merge, squash, rebase', () => {
        expect(allowedMergeMethods({ mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true })).toEqual(['merge', 'squash', 'rebase']);
        expect(allowedMergeMethods({ mergeCommitAllowed: false, squashMergeAllowed: false, rebaseMergeAllowed: true })).toEqual(['rebase']);
        expect(allowedMergeMethods({ mergeCommitAllowed: false, squashMergeAllowed: false, rebaseMergeAllowed: false })).toEqual([]);
    });
});

describe('mapReviewRequests', () => {
    it('changes users, bots and teams, and ignores a reviewer without a name', () => {
        expect(
            mapReviewRequests([
                { requestedReviewer: { __typename: 'User', login: 'bo' } },
                { requestedReviewer: { __typename: 'Team', slug: 'core', name: 'Core' } },
                { requestedReviewer: { __typename: 'Bot', login: 'copilot' } },
                { requestedReviewer: { __typename: 'Team' } },
                { requestedReviewer: null }
            ])
        ).toEqual([
            { kind: 'user', login: 'bo' },
            { kind: 'team', login: 'core', name: 'Core' },
            { kind: 'user', login: 'copilot' }
        ]);
    });
});

describe('mapReactions', () => {
    it('keeps only the reactions with users', () => {
        expect(
            mapReactions([
                { content: 'THUMBS_UP', viewerHasReacted: true, reactors: { totalCount: 2 } },
                { content: 'HEART', viewerHasReacted: false, reactors: { totalCount: 0 } }
            ])
        ).toEqual([{ content: 'THUMBS_UP', count: 2, viewerHasReacted: true }]);
    });

    it('gives no reactions when GitHub gives no groups', () => {
        expect(mapReactions(null)).toEqual([]);
        expect(mapReactions(undefined)).toEqual([]);
    });
});

describe('mapPullRequest', () => {
    it('throws an error when the pull request does not exist', () => {
        const data = graphQlPullRequest();
        data.repository.pullRequest = null;
        expect(() => mapPullRequest(data, repo, 7, undefined)).toThrow('Pull request #7 does not exist in acme/api.');
    });

    it('gives the merge settings of the repository and the permissions of the viewer', () => {
        const pr = mapPullRequest(graphQlPullRequest(), repo, 7, undefined);
        expect(pr.allowedMergeMethods).toEqual(['merge', 'squash']);
        expect(pr.defaultMergeMethod).toBe('squash');
        expect(pr.viewerCanMerge).toBe(true);
        expect(pr.viewerCanManage).toBe(true);
        expect(pr.viewerCanEnableAutoMerge).toBe(true);
        expect(pr.autoMerge).toBeNull();
    });

    it('does not let the viewer turn on auto-merge when the repository does not allow it', () => {
        const pr = mapPullRequest(graphQlPullRequest({}, { autoMergeAllowed: false }), repo, 7, undefined);
        expect(pr.viewerCanEnableAutoMerge).toBe(false);
    });

    it('does not let a viewer with read access merge or manage', () => {
        const pr = mapPullRequest(graphQlPullRequest({}, { viewerPermission: 'READ' }), repo, 7, undefined);
        expect([pr.viewerCanMerge, pr.viewerCanManage]).toEqual([false, false]);
    });

    it('changes the auto-merge request to a method in small letters', () => {
        const pr = mapPullRequest(graphQlPullRequest({ autoMergeRequest: { mergeMethod: 'REBASE', enabledBy: null } }), repo, 7, undefined);
        expect(pr.autoMerge).toEqual({ method: 'rebase', enabledBy: null });
    });

    it('finds the viewer in the requested users but not in the requested teams', () => {
        const asUser = graphQlPullRequest({ reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'me' } }] } });
        const asTeam = graphQlPullRequest({ reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'me', name: 'Me' } }] } });
        expect(mapPullRequest(asUser, repo, 7, undefined).viewerIsRequested).toBe(true);
        expect(mapPullRequest(asTeam, repo, 7, undefined).viewerIsRequested).toBe(false);
    });

    it('uses the GitHub login of a commit author, else the git name', () => {
        const commit = { oid: 'o', abbreviatedOid: 'o', messageHeadline: 'm', committedDate: 'd', url: 'u' };
        const pr = mapPullRequest(
            graphQlPullRequest({
                commits: {
                    totalCount: 140,
                    nodes: [
                        { commit: { ...commit, author: { name: 'Ann A', user: { login: 'ann' } } } },
                        { commit: { ...commit, author: { name: 'Bob B', user: null } } },
                        { commit: { ...commit, author: null } }
                    ]
                }
            }),
            repo,
            7,
            undefined
        );
        expect(pr.commits.map(item => item.author)).toEqual(['ann', 'Bob B', null]);
        expect(pr.commitCount).toBe(140);
    });

    it('counts the checks of the head commit, and gives zero without a check rollup', () => {
        const withChecks = graphQlPullRequest({ headCommit: { nodes: [{ commit: { statusCheckRollup: { contexts: { totalCount: 6 } } } }] } });
        const without = graphQlPullRequest({ headCommit: { nodes: [{ commit: { statusCheckRollup: null } }] } });
        expect(mapPullRequest(withChecks, repo, 7, undefined).checkCount).toBe(6);
        expect(mapPullRequest(without, repo, 7, undefined).checkCount).toBe(0);
    });

    it('changes emoji shortcodes in the body and removes the HTML fields', () => {
        const pr = mapPullRequest(
            graphQlPullRequest({
                comments: { nodes: [{ id: 'c1', author: null, body: 'Looks good :tada:', bodyHTML: '<p>x</p>', createdAt: 'c', url: 'u' }] }
            }),
            repo,
            7,
            undefined
        );
        expect(pr.body).toBe('The body ⚠️');
        expect(pr.issueComments).toEqual([{ id: 'c1', author: null, body: 'Looks good 🎉', createdAt: 'c', url: 'u', reactions: [] }]);
        expect(pr.issueComments[0]).not.toHaveProperty('reactionGroups');
        expect(pr).not.toHaveProperty('bodyHTML');
    });

    it('gives the thread data that "Send to agent" puts in the prompt', () => {
        const pr = mapPullRequest(
            graphQlPullRequest({
                reviewThreads: {
                    nodes: [
                        {
                            id: 'T1',
                            isResolved: false,
                            isOutdated: true,
                            path: 'src/parser.ts',
                            line: null,
                            originalLine: 41,
                            diffSide: 'RIGHT',
                            comments: {
                                nodes: [
                                    {
                                        id: 'C1',
                                        databaseId: 101,
                                        author: { login: 'bo', avatarUrl: 'b' },
                                        body: 'Check for null :eyes:',
                                        bodyHTML: '<p>x</p>',
                                        createdAt: 'c',
                                        url: 'u1'
                                    },
                                    { id: 'C2', databaseId: 102, author: null, body: 'Agreed.', bodyHTML: '<p>y</p>', createdAt: 'd', url: 'u2' }
                                ]
                            }
                        }
                    ]
                }
            }),
            repo,
            7,
            undefined
        );
        expect(pr.number).toBe(7);
        expect(pr.url).toBe('https://github.com/acme/api/pull/7');
        expect(pr.threads).toEqual([
            {
                id: 'T1',
                isResolved: false,
                isOutdated: true,
                path: 'src/parser.ts',
                line: null,
                originalLine: 41,
                side: 'RIGHT',
                comments: [
                    { id: 'C1', databaseId: 101, author: { login: 'bo', avatarUrl: 'b' }, body: 'Check for null 👀', createdAt: 'c', url: 'u1', reactions: [] },
                    { id: 'C2', databaseId: 102, author: null, body: 'Agreed.', createdAt: 'd', url: 'u2', reactions: [] }
                ]
            }
        ]);
    });

    it('replaces a private image link with the signed URL from the rendered HTML', () => {
        const id = '0123abcd-0000-4000-8000-000000000001';
        const signed = `https://private-user-images.githubusercontent.com/1/2-${id}.png?jwt=token`;
        const pr = mapPullRequest(
            graphQlPullRequest({
                body: `![shot](https://github.com/user-attachments/assets/${id})`,
                bodyHTML: `<img src="${signed}">`
            }),
            repo,
            7,
            undefined
        );
        expect(pr.body).toContain(signed);
    });

    it('keeps the timeline that the caller gives', () => {
        const timeline = [{ id: 'e', createdAt: 'c', actor: 'ann', kind: 'closed' as const }];
        expect(mapPullRequest(graphQlPullRequest(), repo, 7, timeline).timeline).toBe(timeline);
        expect(mapPullRequest(graphQlPullRequest(), repo, 7, undefined).timeline).toBeUndefined();
    });
});

describe('mapBranchSummaries', () => {
    const node = (change: Partial<GraphQlBranchPullRequest> = {}): GraphQlBranchPullRequest => ({
        number: 1,
        title: 't',
        url: 'u',
        isDraft: false,
        headRefName: 'feature',
        headRefOid: 'sha',
        reviewDecision: 'APPROVED',
        isCrossRepository: false,
        viewerDidAuthor: true,
        assignees: { nodes: [] },
        reviewRequests: { nodes: [] },
        participants: { nodes: [] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
        ...change
    });

    it('maps the open pull requests by head branch with the CI state', () => {
        expect(mapBranchSummaries({ viewer: { login: 'me' }, repository: { pullRequests: { nodes: [node()] } } })).toEqual({
            feature: { number: 1, title: 't', url: 'u', headSha: 'sha', isDraft: false, reviewDecision: 'APPROVED', checks: 'FAILURE', viewerRole: 'author' }
        });
    });

    it('skips a pull request from a fork and keeps the first pull request of a branch', () => {
        const summaries = mapBranchSummaries({
            viewer: { login: 'me' },
            repository: { pullRequests: { nodes: [node({ number: 1, isCrossRepository: true }), node({ number: 2 }), node({ number: 3 })] } }
        });
        expect(summaries.feature.number).toBe(2);
    });

    it('gives a null CI state to a pull request without checks', () => {
        const summaries = mapBranchSummaries({ viewer: { login: 'me' }, repository: { pullRequests: { nodes: [node({ commits: { nodes: [] } })] } } });
        expect(summaries.feature.checks).toBeNull();
    });
});

describe('mapPullRequestSummaries', () => {
    it('ignores search nodes that are not pull requests and maps the others', () => {
        const summaries = mapPullRequestSummaries([
            {},
            {
                number: 9,
                title: 't',
                isDraft: true,
                state: 'OPEN',
                updatedAt: 'u',
                reviewDecision: null,
                additions: 1,
                deletions: 2,
                viewerDidAuthor: false,
                author: null,
                comments: { totalCount: 4 }
            }
        ]);
        expect(summaries).toEqual([
            {
                number: 9,
                title: 't',
                author: null,
                isDraft: true,
                state: 'OPEN',
                updatedAt: 'u',
                reviewDecision: null,
                checks: null,
                comments: 4,
                additions: 1,
                deletions: 2,
                viewerDidAuthor: false
            }
        ]);
    });
});
