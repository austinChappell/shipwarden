import { describe, expect, it } from 'vitest';
import { DashboardLoader } from './dashboard-loader';
import { fakeClient, queryHas, type FakeCall } from './fake-client';

const recent = () => new Date(Date.now() - 3600 * 1000).toISOString();

const pr = (id: string, change: Record<string, unknown> = {}) => ({
    id,
    number: Number(id.replace(/\D/g, '')) || 1,
    title: `PR ${id}`,
    url: `https://github.com/acme/api/pull/${id}`,
    state: 'OPEN',
    isDraft: false,
    updatedAt: 'u1',
    createdAt: 'c1',
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    repository: { name: 'api', owner: { login: 'acme' } },
    author: { login: 'me' },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
    ...change
});

const comment = (id: string, login: string, typename = 'User') => ({
    id,
    url: `u-${id}`,
    createdAt: recent(),
    bodyText: `text ${id}`,
    bodyHTML: `<p>${id}</p>`,
    author: { __typename: typename, login }
});

describe('DashboardLoader.dashboardPullRequests', () => {
    it('lists the review requests and only the pull requests of the user that need an action', async () => {
        const { client, calls } = fakeClient(call => {
            const q = (call.body as { q: string }).q;
            if (q.includes('review-requested:@me')) return { viewer: { login: 'me' }, search: { nodes: [pr('R1', { author: { login: 'bo' } }), {}] } };
            if (q.includes('reviewed-by:@me')) return { viewer: { login: 'me' }, search: { nodes: [] } };
            return { viewer: { login: 'me' }, search: { nodes: [pr('M2'), pr('M3', { commits: { nodes: [] } })] } };
        });
        const result = await new DashboardLoader(client).dashboardPullRequests(['acme']);
        expect(calls.map(call => (call.body as { q: string }).q)).toEqual([
            'user:acme archived:false is:pr is:open draft:false review-requested:@me sort:updated-desc',
            'user:acme archived:false is:pr is:open author:@me sort:updated-desc',
            'user:acme archived:false is:pr is:open draft:false reviewed-by:@me -author:@me sort:updated-desc'
        ]);
        expect(result.reviewRequests).toEqual([
            {
                repo: { owner: 'acme', name: 'api' },
                number: 1,
                title: 'PR R1',
                url: 'https://github.com/acme/api/pull/R1',
                author: 'bo',
                updatedAt: 'u1',
                createdAt: 'c1'
            }
        ]);
        expect(result.myPullRequests.map(item => [item.number, item.reasons])).toEqual([[2, ['ci-failing']]]);
    });
});

describe('DashboardLoader.dashboardPullRequests: activity after a review', () => {
    const review = (state: string, oid: string) => ({ viewerLatestReview: { state, submittedAt: '2026-11-02T00:00:00Z', commit: { oid } } });
    const said = (login: string, at: string) => ({ createdAt: at, author: { __typename: 'User', login } });

    it('adds the reviewed pull requests with a new commit or a new comment from another person', async () => {
        const reviewed = [
            // Also requested. The request comes first, without the activity.
            pr('R1', { author: { login: 'bo' }, headRefOid: 'new', ...review('COMMENTED', 'old') }),
            pr('A4', { author: { login: 'bo' }, headRefOid: 'new', ...review('COMMENTED', 'old') }),
            pr('A5', { author: { login: 'bo' }, headRefOid: 'same', ...review('APPROVED', 'same') }),
            pr('A6', {
                author: { login: 'bo' },
                headRefOid: 'same',
                ...review('COMMENTED', 'same'),
                comments: { nodes: [said('me', '2026-11-03T00:00:00Z')] }
            }),
            pr('A7', { author: { login: 'bo' }, headRefOid: 'same', ...review('APPROVED', 'same'), comments: { nodes: [said('cy', '2026-11-03T00:00:00Z')] } }),
            pr('A8', { author: { login: 'bo' }, headRefOid: 'same', ...review('PENDING', 'old') })
        ];
        const { client } = fakeClient(call => {
            const q = (call.body as { q: string }).q;
            if (q.includes('review-requested:@me')) return { viewer: { login: 'me' }, search: { nodes: [pr('R1', { author: { login: 'bo' } })] } };
            if (q.includes('reviewed-by:@me')) return { viewer: { login: 'me' }, search: { nodes: reviewed } };
            return { viewer: { login: 'me' }, search: { nodes: [] } };
        });
        const result = await new DashboardLoader(client).dashboardPullRequests(['acme']);
        expect(result.reviewRequests.map(item => [item.number, item.activity])).toEqual([
            [1, undefined],
            [
                4,
                {
                    reviewState: 'COMMENTED',
                    reviewedAt: '2026-11-02T00:00:00Z',
                    newCommits: true,
                    lastCommentAt: undefined,
                    seenKey: 'rr:https://github.com/acme/api/pull/A4:new:'
                }
            ],
            [
                7,
                {
                    reviewState: 'APPROVED',
                    reviewedAt: '2026-11-02T00:00:00Z',
                    newCommits: false,
                    lastCommentAt: '2026-11-03T00:00:00Z',
                    seenKey: 'rr:https://github.com/acme/api/pull/A7:same:2026-11-03T00:00:00Z'
                }
            ]
        ]);
    });
});

describe('DashboardLoader.dashboardComments', () => {
    const respond = (nodes: () => unknown[]) => (call: FakeCall) =>
        queryHas(call, 'nodes(ids:') ? { nodes: nodes() } : { viewer: { login: 'me' }, search: { nodes: [pr('P1')] } };

    it('returns the new comments of other users and skips bots and the user', async () => {
        const { client } = fakeClient(
            respond(() => [
                {
                    id: 'P1',
                    updatedAt: 'u1',
                    comments: { nodes: [comment('c1', 'bo'), comment('c2', 'dependabot[bot]'), comment('c3', 'ci', 'Bot')] },
                    reviews: {
                        nodes: [
                            { ...comment('r1', 'bo'), bodyText: ' ', state: 'COMMENTED' },
                            { ...comment('r2', 'cy'), bodyText: '', state: 'APPROVED' }
                        ]
                    },
                    reviewThreads: { nodes: [{ path: 'src/a.ts', comments: { nodes: [comment('t1', 'bo')] } }] }
                }
            ])
        );
        const result = await new DashboardLoader(client).dashboardComments(undefined);
        expect(result.map(item => [item.id, item.path, item.reviewState]).sort()).toEqual([
            ['c1', undefined, undefined],
            ['r2', undefined, 'APPROVED'],
            ['t1', 'src/a.ts', undefined]
        ]);
    });

    it('loads the comments of a pull request again only after it changes', async () => {
        let loads = 0;
        const { client, calls } = fakeClient(
            respond(() => {
                loads++;
                return [{ id: 'P1', updatedAt: 'u1', comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } }];
            })
        );
        const loader = new DashboardLoader(client);
        await loader.dashboardComments(undefined);
        await loader.dashboardComments(undefined);
        expect(loads).toBe(1);
        expect(calls.filter(call => queryHas(call, 'nodes(ids:')).map(call => call.body)).toEqual([{ ids: ['P1'] }]);
    });

    it('asks for the comments of at most 10 pull requests in one request', async () => {
        const many = Array.from({ length: 23 }, (_, index) => pr(`P${index + 1}`));
        const { client, calls } = fakeClient(call => (queryHas(call, 'nodes(ids:') ? { nodes: [] } : { viewer: { login: 'me' }, search: { nodes: many } }));
        await new DashboardLoader(client).dashboardComments(undefined);
        const sizes = calls.filter(call => queryHas(call, 'nodes(ids:')).map(call => (call.body as { ids: string[] }).ids.length);
        expect(sizes.sort((a, b) => a - b)).toEqual([3, 10, 10]);
    });
});
