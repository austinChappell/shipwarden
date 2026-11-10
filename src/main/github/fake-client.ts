import type { GitHubClient } from './github-client';
import type { GraphQlPullRequest } from './pull-request-mapping';

/** One call to the fake client. `body` is the REST body or the GraphQL variables. */
export interface FakeCall {
    kind: 'rest' | 'graphql' | 'text' | 'paginate';
    method: string;
    path: string;
    body?: unknown;
    accept?: string;
    limit?: number;
}

/** Gives the canned data for a call. A thrown error or a rejected promise makes the call fail. */
export type FakeResponder = (call: FakeCall) => unknown;

/**
 * Makes a fake GitHub client for tests. It records each REST, GraphQL, text and page call.
 * It gets the data from `respond` and does not use the network.
 */
export function fakeClient(respond: FakeResponder = () => undefined): { client: GitHubClient; calls: FakeCall[] } {
    const calls: FakeCall[] = [];
    const send = async (call: FakeCall) => {
        calls.push(call);
        return respond(call);
    };
    const client = {
        rest: (method: string, path: string, body?: unknown) => send({ kind: 'rest', method, path, body }),
        graphql: (query: string, variables: Record<string, unknown>) => send({ kind: 'graphql', method: 'POST', path: query, body: variables }),
        text: (path: string, accept?: string) => send({ kind: 'text', method: 'GET', path, accept }),
        paginate: async (path: string, pick?: (page: unknown) => unknown[], limit?: number) => {
            const page = await send({ kind: 'paginate', method: 'GET', path, limit });
            return pick ? pick(page) : page;
        }
    };
    return { client: client as unknown as GitHubClient, calls };
}

/** Returns true when a GraphQL call has the text in its query. */
export function queryHas(call: FakeCall, text: string): boolean {
    return call.kind === 'graphql' && call.path.includes(text);
}

type RawPullRequest = NonNullable<GraphQlPullRequest['repository']['pullRequest']>;

/** Makes the GraphQL data of a pull request. The test changes only the fields that it checks. */
export function graphQlPullRequest(pr: Partial<RawPullRequest> = {}, repository: Partial<GraphQlPullRequest['repository']> = {}): GraphQlPullRequest {
    return {
        viewer: { login: 'me' },
        repository: {
            mergeCommitAllowed: true,
            squashMergeAllowed: true,
            rebaseMergeAllowed: false,
            autoMergeAllowed: true,
            viewerDefaultMergeMethod: 'SQUASH',
            viewerPermission: 'WRITE',
            pullRequest: {
                id: 'PR1',
                number: 7,
                title: 'Fix the parser',
                body: 'The body :warning:',
                bodyHTML: '<p>The body</p>',
                url: 'https://github.com/acme/api/pull/7',
                state: 'OPEN',
                isDraft: false,
                mergeable: 'MERGEABLE',
                mergeStateStatus: 'CLEAN',
                reviewDecision: null,
                author: { login: 'ann', avatarUrl: 'a' },
                baseRefName: 'main',
                headRefName: 'fix-parser',
                isCrossRepository: false,
                baseRefOid: 'base1',
                headRefOid: 'head1',
                additions: 3,
                deletions: 1,
                changedFiles: 2,
                createdAt: 'c',
                viewerDidAuthor: false,
                viewerCanUpdate: true,
                viewerCanEnableAutoMerge: true,
                viewerCanDisableAutoMerge: false,
                autoMergeRequest: null,
                assignees: { nodes: [] },
                labels: { nodes: [] },
                reviewRequests: { nodes: [] },
                reviews: { nodes: [] },
                comments: { nodes: [] },
                reviewThreads: { nodes: [] },
                commits: { totalCount: 0, nodes: [] },
                headCommit: { nodes: [] },
                ...pr
            },
            ...repository
        }
    };
}
