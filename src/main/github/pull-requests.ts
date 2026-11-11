import {
    pullRequestSearch,
    type BranchSummary,
    type CommitFiles,
    type FileVersions,
    type GitHubLabel,
    type GitHubOwner,
    type GitHubRepoInfo,
    type GitHubUser,
    type NewPullRequest,
    type PullRequest,
    type IssueReference,
    type PullRequestCandidates,
    type PullRequestFile,
    type PullRequestFilter,
    type PullRequestSummary,
    type RepoRef
} from '@shared/github';
import { GitHubError, type GitHubClient } from './github-client';
import {
    BRANCH_SUMMARIES_QUERY,
    mapBranchSummaries,
    mapPullRequest,
    mapPullRequestSummaries,
    PULL_REQUEST_QUERY,
    type GraphQlBranchSummaries,
    type GraphQlPullRequest,
    type GraphQlSummary
} from './pull-request-mapping';
import { mapTimeline, TIMELINE_QUERY, type GraphQlTimeline } from './timeline';

/** The diff view does not load file versions that are larger than this limit. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Returns a pull request with its reviews, comments, threads, commits and timeline. */
export async function fetchPullRequest(client: GitHubClient, repo: RepoRef, number: number): Promise<PullRequest> {
    const variables = { owner: repo.owner, name: repo.name, number };
    // A failed timeline does not stop the pull request. The Overview then shows only the comments and the reviews.
    const [data, timeline] = await Promise.all([
        client.graphql<GraphQlPullRequest>(PULL_REQUEST_QUERY, variables),
        client.graphql<GraphQlTimeline>(TIMELINE_QUERY, variables).then(
            result => mapTimeline(result.repository.pullRequest?.timelineItems.nodes ?? []),
            err => {
                console.warn(`The timeline of pull request #${number} did not load: ${err instanceof Error ? err.message : String(err)}`);
                return undefined;
            }
        )
    ]);
    return mapPullRequest(data, repo, number, timeline);
}

/** Creates a pull request from a branch. The base is the default branch when the request has none. Returns its number. */
export async function createPullRequest(client: GitHubClient, repo: RepoRef, branch: string, request: NewPullRequest): Promise<number> {
    const base = request.base || (await client.rest<{ default_branch: string }>('GET', `/repos/${repo.owner}/${repo.name}`)).default_branch;
    const created = await client.rest<{ number: number }>('POST', `/repos/${repo.owner}/${repo.name}/pulls`, {
        title: request.title,
        body: request.body,
        head: branch,
        base,
        draft: request.draft
    });
    return created.number;
}

/** Returns the open pull requests of the repository by head branch, with the combined CI state. */
export async function fetchBranchSummaries(client: GitHubClient, repo: RepoRef): Promise<Record<string, BranchSummary>> {
    return mapBranchSummaries(await client.graphql<GraphQlBranchSummaries>(BRANCH_SUMMARIES_QUERY, { owner: repo.owner, name: repo.name }));
}

/** Returns the users that the user can assign or ask for a review, and the labels of the repository. */
export async function fetchPullRequestCandidates(client: GitHubClient, repo: RepoRef): Promise<PullRequestCandidates> {
    const query = `query($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            assignableUsers(first: 100) { nodes { login avatarUrl name } }
            labels(first: 100, orderBy: { field: NAME, direction: ASC }) { nodes { name color description } }
          }
        }`;
    type Node = { login: string; avatarUrl?: string; name?: string | null };
    const data = await client.graphql<{ repository: { assignableUsers: { nodes: Node[] }; labels: { nodes: GitHubLabel[] } } }>(query, {
        owner: repo.owner,
        name: repo.name
    });
    // GitHub sends null or "" when the user has no name.
    const users = data.repository.assignableUsers.nodes.map(({ name, ...user }): GitHubUser => (name ? { ...user, name } : user));
    return { users, labels: data.repository.labels.nodes };
}

const REFERENCE_FIELDS = `__typename
    ... on Issue { number title state }
    ... on PullRequest { number title state isDraft }`;

type GraphQlReference = { __typename?: string; number?: number; title?: string; state?: IssueReference['state']; isDraft?: boolean } | null;

function mapReference(node: GraphQlReference): IssueReference | null {
    if (!node || typeof node.number !== 'number' || !node.state) return null;
    return {
        number: node.number,
        title: node.title ?? '',
        kind: node.__typename === 'PullRequest' ? 'pullRequest' : 'issue',
        state: node.state,
        ...(node.isDraft ? { isDraft: true } : {})
    };
}

async function searchReferences(client: GitHubClient, search: string, first: number): Promise<IssueReference[]> {
    const data = await client.graphql<{ search: { nodes: GraphQlReference[] } }>(
        `query($search: String!, $first: Int!) { search(query: $search, type: ISSUE, first: $first) { nodes { ${REFERENCE_FIELDS} } } }`,
        { search, first }
    );
    return data.search.nodes.map(mapReference).filter((item): item is IssueReference => item !== null);
}

/**
 * Returns the issues and the pull requests of the repository for a "#" reference, the most recently updated first.
 * - An empty query gives the most recent items.
 * - A number gives the item with that number first, and then the recent items whose number starts with the digits.
 * - Other text gives the items with the words in the title.
 */
export async function fetchIssueReferences(client: GitHubClient, repo: RepoRef, query: string): Promise<IssueReference[]> {
    const text = query.trim().replace(/["\\]/g, '');
    const scope = `repo:${repo.owner}/${repo.name} sort:updated-desc`;
    if (!/^\d{1,9}$/.test(text)) {
        return searchReferences(client, text ? `${scope} in:title ${text}` : scope, 20);
    }
    const [exact, recent] = await Promise.all([
        client
            .graphql<{ repository: { issueOrPullRequest: GraphQlReference } }>(
                `query($owner: String!, $name: String!, $number: Int!) {
                  repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) { ${REFERENCE_FIELDS} } }
                }`,
                { owner: repo.owner, name: repo.name, number: Number(text) }
            )
            .then(data => mapReference(data.repository.issueOrPullRequest))
            // GitHub returns an error when no issue or pull request has the number.
            .catch(() => null),
        searchReferences(client, scope, 50)
    ]);
    const matches = recent.filter(item => item.number !== exact?.number && String(item.number).startsWith(text));
    return [...(exact ? [exact] : []), ...matches].slice(0, 20);
}

/** Returns the changed files of a pull request. A failed load of the viewed state gives no viewed files. */
export async function fetchPullRequestFiles(client: GitHubClient, repo: RepoRef, number: number): Promise<PullRequestFile[]> {
    const [files, viewed] = await Promise.all([
        client.paginate<RestFile>(`/repos/${repo.owner}/${repo.name}/pulls/${number}/files`),
        fetchViewedFiles(client, repo, number).catch(() => new Set<string>())
    ]);
    return files.map(file => ({ ...mapRestFile(file), viewed: viewed.has(file.filename) }));
}

type RestFile = { filename: string; previous_filename?: string; status: string; additions: number; deletions: number; patch?: string };

function mapRestFile(file: RestFile): PullRequestFile {
    return {
        path: file.filename,
        previousPath: file.previous_filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        ...(file.patch ? { patch: file.patch } : {})
    };
}

/** Returns the changed files of one commit and its first parent. GitHub sends the files in pages of 100, up to 3000 files. */
export async function fetchCommitFiles(client: GitHubClient, repo: RepoRef, sha: string): Promise<CommitFiles> {
    let parentSha: string | null = null;
    const files = await client.paginate<RestFile>(`/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(sha)}`, page => {
        const commit = page as { parents?: { sha: string }[]; files?: RestFile[] };
        parentSha ??= commit.parents?.[0]?.sha ?? null;
        return commit.files ?? [];
    });
    return { parentSha, files: files.map(mapRestFile) };
}

/** Returns the files that the user marked as viewed. Only GraphQL has this state. */
export async function fetchViewedFiles(client: GitHubClient, repo: RepoRef, number: number): Promise<Set<string>> {
    const viewed = new Set<string>();
    let after: string | null = null;
    // A pull request can have 3000 files. GraphQL returns 100 on each page.
    for (let page = 0; page < 30; page++) {
        const data: {
            repository: {
                pullRequest: { files: { nodes: { path: string; viewerViewedState: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
            };
        } = await client.graphql(
            `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: 100, after: $after) { nodes { path viewerViewedState } pageInfo { hasNextPage endCursor } }
    }
  }
}`,
            { owner: repo.owner, name: repo.name, number, after }
        );
        const files = data.repository.pullRequest.files;
        files.nodes.filter(file => file.viewerViewedState === 'VIEWED').forEach(file => viewed.add(file.path));
        if (!files.pageInfo.hasNextPage) break;
        after = files.pageInfo.endCursor;
    }
    return viewed;
}

/**
 * Returns the pull requests of a repository for a filter of the Review view, the newest update first.
 * The closed list is shorter and has no CI state, because GitHub is slow to get the CI state of old pull requests.
 */
export async function fetchPullRequests(client: GitHubClient, repo: RepoRef, filter: PullRequestFilter, query?: string): Promise<PullRequestSummary[]> {
    const closed = filter === 'closed' || filter === 'merged';
    const data = await client.graphql<{ search: { nodes: (GraphQlSummary | Record<string, never>)[] } }>(
        `query($q: String!, $first: Int!, $checks: Boolean!) {
  search(query: $q, type: ISSUE, first: $first) {
    nodes {
      ... on PullRequest {
        number title isDraft state updatedAt reviewDecision additions deletions viewerDidAuthor
        author { login }
        comments { totalCount }
        commits(last: 1) @include(if: $checks) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`,
        { q: `${pullRequestSearch(repo, filter, query)} sort:updated-desc`, first: closed ? 30 : 50, checks: !closed }
    );
    return mapPullRequestSummaries(data.search.nodes);
}

/** Returns the base and head versions of a file in a pull request. A missing version is an empty string. */
export async function fetchFileVersions(client: GitHubClient, repo: RepoRef, file: PullRequestFile, baseSha: string, headSha: string): Promise<FileVersions> {
    const read = async (filePath: string, sha: string): Promise<string | undefined> => {
        try {
            const text = await client.text(`/repos/${repo.owner}/${repo.name}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`);
            if (text.length > MAX_FILE_BYTES || text.slice(0, 8000).includes('\0')) {
                return undefined;
            }
            return text;
        } catch (error) {
            if (error instanceof GitHubError && error.status === 404) {
                return '';
            }
            throw error;
        }
    };
    const [base, head] = await Promise.all([
        file.status === 'added' ? Promise.resolve('') : read(file.previousPath ?? file.path, baseSha),
        file.status === 'removed' ? Promise.resolve('') : read(file.path, headSha)
    ]);
    if (base === undefined || head === undefined) {
        return { base: '', head: '', unavailable: true };
    }
    return { base, head };
}

/** Returns the user and the organizations of the token, for the organization choice of the Review view. */
export async function fetchOwners(client: GitHubClient): Promise<GitHubOwner[]> {
    const [user, orgs] = await Promise.all([client.rest<{ login: string }>('GET', '/user'), client.paginate<{ login: string }>('/user/orgs', undefined, 300)]);
    return [{ login: user.login, kind: 'user' }, ...orgs.map(org => ({ login: org.login, kind: 'organization' as const }))];
}

/**
 * Returns the repositories that the user can access, of the given owners (all owners when undefined),
 * the repository with the newest push first.
 */
export async function fetchRepositories(client: GitHubClient, owners?: string[]): Promise<GitHubRepoInfo[]> {
    const wanted = owners ? new Set(owners.map(owner => owner.toLowerCase())) : undefined;
    const repos = await client.paginate<{ name: string; owner: { login: string }; pushed_at?: string; archived: boolean }>(
        '/user/repos?sort=pushed&affiliation=owner,collaborator,organization_member',
        undefined,
        1000
    );
    return repos
        .filter(repo => !repo.archived && (!wanted || wanted.has(repo.owner.login.toLowerCase())))
        .map(repo => ({ owner: repo.owner.login, name: repo.name, pushedAt: repo.pushed_at }));
}

/** Returns the branches of a repository (at most 300), the default branch first. */
export async function fetchBranches(client: GitHubClient, repo: RepoRef): Promise<string[]> {
    const [info, list] = await Promise.all([
        client.rest<{ default_branch: string }>('GET', `/repos/${repo.owner}/${repo.name}`),
        client.paginate<{ name: string }>(`/repos/${repo.owner}/${repo.name}/branches`, undefined, 300)
    ]);
    const names = list.map(branch => branch.name).filter(name => name !== info.default_branch);
    return [info.default_branch, ...names];
}
