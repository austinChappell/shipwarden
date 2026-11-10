import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PullRequestFile } from '@shared/github';
import { GitHubError } from './github-client';
import { fakeClient, graphQlPullRequest, queryHas } from './fake-client';
import {
    createPullRequest,
    fetchBranches,
    fetchFileVersions,
    fetchPullRequest,
    fetchPullRequestFiles,
    fetchPullRequests,
    fetchRepositories,
    MAX_FILE_BYTES
} from './pull-requests';

const repo = { owner: 'acme', name: 'api' };

afterEach(() => {
    vi.restoreAllMocks();
});

describe('fetchPullRequest', () => {
    it('loads the pull request and the timeline with the same variables', async () => {
        const { client, calls } = fakeClient(call =>
            queryHas(call, 'timelineItems')
                ? {
                      repository: {
                          pullRequest: { timelineItems: { nodes: [{ __typename: 'ClosedEvent', id: 'e', createdAt: 'c', actor: { login: 'ann' } }] } }
                      }
                  }
                : graphQlPullRequest()
        );
        const pr = await fetchPullRequest(client, repo, 7);
        expect(calls.map(call => call.body)).toEqual([
            { owner: 'acme', name: 'api', number: 7 },
            { owner: 'acme', name: 'api', number: 7 }
        ]);
        expect(pr.timeline).toEqual([{ id: 'e', createdAt: 'c', actor: 'ann', kind: 'closed' }]);
    });

    it('returns the pull request without a timeline when the timeline fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { client } = fakeClient(call => (queryHas(call, 'timelineItems') ? Promise.reject(new Error('timeout')) : graphQlPullRequest()));
        const pr = await fetchPullRequest(client, repo, 7);
        expect(pr.number).toBe(7);
        expect(pr.timeline).toBeUndefined();
        expect(warn).toHaveBeenCalledWith('The timeline of pull request #7 did not load: timeout');
    });

    it('fails when the pull request query fails', async () => {
        const { client } = fakeClient(call =>
            queryHas(call, 'timelineItems') ? { repository: { pullRequest: null } } : Promise.reject(new GitHubError('GitHub returned 502.', 502))
        );
        await expect(fetchPullRequest(client, repo, 7)).rejects.toMatchObject({ status: 502 });
    });
});

describe('createPullRequest', () => {
    it('uses the default branch of the repository when the request has no base', async () => {
        const { client, calls } = fakeClient(call => (call.method === 'GET' ? { default_branch: 'develop' } : { number: 12 }));
        expect(await createPullRequest(client, repo, 'feature', { title: 'T', body: 'B', draft: true })).toBe(12);
        expect(calls).toEqual([
            { kind: 'rest', method: 'GET', path: '/repos/acme/api', body: undefined },
            { kind: 'rest', method: 'POST', path: '/repos/acme/api/pulls', body: { title: 'T', body: 'B', head: 'feature', base: 'develop', draft: true } }
        ]);
    });

    it('uses the base of the request without a request for the default branch', async () => {
        const { client, calls } = fakeClient(() => ({ number: 13 }));
        await createPullRequest(client, repo, 'feature', { title: 'T', body: '', base: 'release', draft: false });
        expect(calls).toHaveLength(1);
        expect(calls[0].body).toMatchObject({ base: 'release' });
    });
});

describe('fetchPullRequestFiles', () => {
    const files = [
        { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@' },
        { filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0 }
    ];

    it('marks the viewed files and keeps the patch only when GitHub sends one', async () => {
        const { client } = fakeClient(call =>
            call.kind === 'paginate'
                ? files
                : {
                      repository: {
                          pullRequest: {
                              files: { nodes: [{ path: 'src/new.ts', viewerViewedState: 'VIEWED' }], pageInfo: { hasNextPage: false, endCursor: null } }
                          }
                      }
                  }
        );
        expect(await fetchPullRequestFiles(client, repo, 7)).toEqual([
            { path: 'src/a.ts', previousPath: undefined, status: 'modified', additions: 1, deletions: 0, viewed: false, patch: '@@ -1 +1 @@' },
            { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0, viewed: true }
        ]);
    });

    it('marks no file as viewed when the viewed state fails', async () => {
        const { client } = fakeClient(call => (call.kind === 'paginate' ? files : Promise.reject(new Error('GraphQL failed'))));
        const result = await fetchPullRequestFiles(client, repo, 7);
        expect(result.map(file => file.viewed)).toEqual([false, false]);
    });

    it('reads the next page of the viewed state with the end cursor', async () => {
        let page = 0;
        const { client, calls } = fakeClient(call => {
            if (call.kind === 'paginate') return files;
            page++;
            return { repository: { pullRequest: { files: { nodes: [], pageInfo: { hasNextPage: page < 2, endCursor: `cursor${page}` } } } } };
        });
        await fetchPullRequestFiles(client, repo, 7);
        expect(calls.filter(call => call.kind === 'graphql').map(call => (call.body as { after: string | null }).after)).toEqual([null, 'cursor1']);
    });
});

describe('fetchFileVersions', () => {
    const file = (change: Partial<PullRequestFile> = {}): PullRequestFile => ({
        path: 'src/a b.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        ...change
    });

    it('reads the base and the head version with an encoded path', async () => {
        const { client, calls } = fakeClient(call => (call.path.includes('ref=base1') ? 'old' : 'new'));
        expect(await fetchFileVersions(client, repo, file(), 'base1', 'head1')).toEqual({ base: 'old', head: 'new' });
        expect(calls.map(call => call.path)).toEqual(['/repos/acme/api/contents/src/a%20b.ts?ref=base1', '/repos/acme/api/contents/src/a%20b.ts?ref=head1']);
    });

    it('reads the base of a renamed file at its old path', async () => {
        const { client, calls } = fakeClient(() => 'x');
        await fetchFileVersions(client, repo, file({ status: 'renamed', previousPath: 'src/old.ts' }), 'base1', 'head1');
        expect(calls[0].path).toBe('/repos/acme/api/contents/src/old.ts?ref=base1');
    });

    it('does not read the base of an added file or the head of a removed file', async () => {
        const { client, calls } = fakeClient(() => 'x');
        expect(await fetchFileVersions(client, repo, file({ status: 'added' }), 'base1', 'head1')).toEqual({ base: '', head: 'x' });
        expect(await fetchFileVersions(client, repo, file({ status: 'removed' }), 'base1', 'head1')).toEqual({ base: 'x', head: '' });
        expect(calls).toHaveLength(2);
    });

    it('gives an empty version when GitHub returns 404', async () => {
        const { client } = fakeClient(call => (call.path.includes('ref=base1') ? Promise.reject(new GitHubError('Not found', 404)) : 'new'));
        expect(await fetchFileVersions(client, repo, file(), 'base1', 'head1')).toEqual({ base: '', head: 'new' });
    });

    it('gives the other errors to the caller', async () => {
        const { client } = fakeClient(() => Promise.reject(new GitHubError('Server error', 500)));
        await expect(fetchFileVersions(client, repo, file(), 'base1', 'head1')).rejects.toMatchObject({ status: 500 });
    });

    it('marks a binary file or a large file as not available', async () => {
        const binary = fakeClient(() => 'abc\0def');
        const large = fakeClient(() => 'x'.repeat(MAX_FILE_BYTES + 1));
        expect(await fetchFileVersions(binary.client, repo, file(), 'base1', 'head1')).toEqual({ base: '', head: '', unavailable: true });
        expect(await fetchFileVersions(large.client, repo, file(), 'base1', 'head1')).toEqual({ base: '', head: '', unavailable: true });
    });
});

describe('fetchPullRequests', () => {
    it('asks for 50 open pull requests with the CI state', async () => {
        const { client, calls } = fakeClient(() => ({ search: { nodes: [] } }));
        await fetchPullRequests(client, repo, 'open');
        expect(calls[0].body).toMatchObject({ first: 50, checks: true });
        expect((calls[0].body as { q: string }).q).toMatch(/repo:acme\/api.* sort:updated-desc$/);
    });

    it('asks for 30 closed pull requests without the CI state', async () => {
        const { client, calls } = fakeClient(() => ({ search: { nodes: [] } }));
        await fetchPullRequests(client, repo, 'closed');
        expect(calls[0].body).toMatchObject({ first: 30, checks: false });
    });
});

describe('fetchRepositories', () => {
    it('removes archived repositories and repositories of other owners', async () => {
        const { client } = fakeClient(() => [
            { name: 'api', owner: { login: 'Acme' }, pushed_at: 'p', archived: false },
            { name: 'old', owner: { login: 'acme' }, archived: true },
            { name: 'web', owner: { login: 'other' }, archived: false }
        ]);
        expect(await fetchRepositories(client, ['acme'])).toEqual([{ owner: 'Acme', name: 'api', pushedAt: 'p' }]);
        expect(await fetchRepositories(client)).toHaveLength(2);
    });
});

describe('fetchBranches', () => {
    it('puts the default branch first and does not repeat it', async () => {
        const { client } = fakeClient(call => (call.kind === 'rest' ? { default_branch: 'main' } : [{ name: 'a' }, { name: 'main' }, { name: 'b' }]));
        expect(await fetchBranches(client, repo)).toEqual(['main', 'a', 'b']);
    });
});
