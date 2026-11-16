import { describe, expect, it } from 'vitest';
import { fakeClient, queryHas } from './fake-client';
import { fetchRepoPullRequests, joinOpenPullRequests, type GraphQlOpenPr } from './repo-pull-requests';

const node = (number: number, change: Partial<GraphQlOpenPr> = {}): GraphQlOpenPr => ({
    id: `PR${number}`,
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/api/pull/${number}`,
    isDraft: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: `2026-01-${String(number).padStart(2, '0')}T00:00:00Z`,
    headRefName: 'head',
    baseRefName: 'main',
    headRefOid: 'h1',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    viewerDidAuthor: false,
    reviewDecision: null,
    author: { login: 'bo' },
    comments: { totalCount: 0, nodes: [] },
    reviews: { nodes: [] },
    viewerLatestReview: null,
    commits: { nodes: [] },
    ...change
});

describe('joinOpenPullRequests', () => {
    it('removes duplicates, keeps the fields of the searches, and puts the newest update first', () => {
        const joined = joinOpenPullRequests(
            [node(5), node(3, { viewerDidAuthor: true })],
            [node(3, { viewerDidAuthor: true, mergeable: 'CONFLICTING' }), node(1)]
        );
        expect(joined.map(item => [item.number, item.mergeable])).toEqual([
            [5, undefined],
            [3, 'CONFLICTING'],
            [1, undefined]
        ]);
    });
});

describe('fetchRepoPullRequests', () => {
    it('adds older pull requests from the searches to the recent list', async () => {
        const { client, calls } = fakeClient(() => ({
            viewer: { login: 'me' },
            repository: { pushedAt: null, pullRequests: { totalCount: 120, nodes: [node(9), node(8)] } },
            requested: { nodes: [node(2), {}] },
            reviewed: { nodes: [] },
            mine: { nodes: [node(8, { viewerDidAuthor: true, author: { login: 'me' }, mergeable: 'CONFLICTING' })] }
        }));
        const result = await fetchRepoPullRequests(client, { owner: 'acme', name: 'api' });
        expect(calls).toHaveLength(1);
        expect(calls[0].body).toEqual({
            owner: 'acme',
            name: 'api',
            requested: 'repo:acme/api is:pr is:open sort:updated-desc draft:false review-requested:@me',
            reviewed: 'repo:acme/api is:pr is:open sort:updated-desc reviewed-by:@me -author:@me',
            mine: 'repo:acme/api is:pr is:open sort:updated-desc author:@me'
        });
        expect(result.openCount).toBe(120);
        expect(result.pullRequests.map(pr => [pr.number, pr.reviewRequested, pr.actions])).toEqual([
            [9, false, []],
            [8, false, ['conflicts']],
            [2, true, []]
        ]);
    });

    it('does not ask for the slow merge state of each pull request', async () => {
        const { client, calls } = fakeClient(() => ({
            viewer: { login: 'me' },
            repository: { pushedAt: null, pullRequests: { totalCount: 0, nodes: [] } },
            requested: { nodes: [] },
            reviewed: { nodes: [] },
            mine: { nodes: [] }
        }));
        await fetchRepoPullRequests(client, { owner: 'acme', name: 'api' });
        expect(queryHas(calls[0], 'mergeStateStatus')).toBe(false);
        expect(calls[0].path.match(/mergeable/g)).toHaveLength(1);
    });

    it('loads the changes after the review for each batch of pull requests to review again, at the same time', async () => {
        const reviewedNode = (number: number) =>
            node(number, { viewerLatestReview: { state: 'COMMENTED', submittedAt: '2026-01-01T00:00:00Z', commit: { oid: 'old' } } });
        const reviewed = Array.from({ length: 25 }, (_, index) => reviewedNode(index + 1));
        let running = 0;
        let most = 0;
        const { client, calls } = fakeClient(async call => {
            if (queryHas(call, 'reviewThreads')) {
                running++;
                most = Math.max(most, running);
                await new Promise(resolve => setTimeout(resolve, 5));
                running--;
                const ids = (call.body as { ids: string[] }).ids;
                return {
                    nodes: ids.map(id => ({ id, commits: { nodes: [{ commit: { oid: 'old' } }, { commit: { oid: 'new' } }] }, reviewThreads: { nodes: [] } }))
                };
            }
            return {
                viewer: { login: 'me' },
                repository: { pushedAt: null, pullRequests: { totalCount: 25, nodes: [] } },
                requested: { nodes: reviewed },
                reviewed: { nodes: [] },
                mine: { nodes: [] }
            };
        });
        const result = await fetchRepoPullRequests(client, { owner: 'acme', name: 'api' });
        expect(calls.filter(call => queryHas(call, 'reviewThreads'))).toHaveLength(2);
        expect(most).toBe(2);
        expect(result.pullRequests.every(pr => pr.sinceReview?.newCommits === 1)).toBe(true);
    });
});
