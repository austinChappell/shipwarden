import type { RepoRef } from '@shared/github';
import {
    DASHBOARD_WINDOW_DAYS,
    myPullRequestReasons,
    newComments,
    ownerQualifiers,
    type DashboardPullRequests,
    type PullRequestCommentItem
} from '@shared/dashboard';
import type { GitHubClient } from './github-client';

const DASHBOARD_COMMENT_FIELDS = 'id url createdAt bodyText bodyHTML author { __typename login }';

const DASHBOARD_SUMMARY_FIELDS = `
  id number title url state isDraft updatedAt createdAt reviewDecision mergeable mergeStateStatus
  repository { name owner { login } }
  author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

/** The comments of pull requests by node ID. The Dashboard asks only for pull requests that changed. */
const DASHBOARD_COMMENTS_QUERY = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequest {
  id updatedAt
  comments(last: 20) { nodes { ${DASHBOARD_COMMENT_FIELDS} } }
  reviews(last: 20) { nodes { ${DASHBOARD_COMMENT_FIELDS} state } }
  reviewThreads(last: 30) { nodes { path comments(last: 10) { nodes { ${DASHBOARD_COMMENT_FIELDS} } } } }
} } }`;

/** The number of pull requests in one request for comments. A larger request can pass the time limit of GitHub. */
const DASHBOARD_COMMENTS_BATCH = 10;

function dashboardRepo(pr: DashboardPr): RepoRef {
    return { owner: pr.repository.owner.login, name: pr.repository.name };
}

function dashboardSearch(first: number): string {
    return `query($q: String!) { viewer { login } search(query: $q, type: ISSUE, first: ${first}) { nodes { ... on PullRequest { ${DASHBOARD_SUMMARY_FIELDS} } } } }`;
}

interface DashboardComment {
    id: string;
    url: string;
    createdAt: string;
    bodyText: string;
    bodyHTML: string;
    author: { __typename: string; login: string } | null;
    state?: string;
}

interface DashboardPr {
    id: string;
    number: number;
    title: string;
    url: string;
    state: string;
    isDraft: boolean;
    updatedAt: string;
    createdAt: string;
    reviewDecision: string | null;
    mergeable: string;
    mergeStateStatus: string;
    repository: { name: string; owner: { login: string } };
    author: { login: string } | null;
    commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

interface DashboardPrComments {
    id: string;
    updatedAt: string;
    comments: { nodes: DashboardComment[] };
    reviews: { nodes: DashboardComment[] };
    reviewThreads: { nodes: { path: string; comments: { nodes: DashboardComment[] } }[] };
}

/** Loads the pull requests and the new comments for the Dashboard. It keeps the comments in memory between loads. */
export class DashboardLoader {
    /** The comments of each pull request for the Dashboard, by node ID, with the `updatedAt` of the pull request at the load. */
    private readonly dashboardCommentCache = new Map<string, DashboardPrComments>();

    constructor(private readonly client: GitHubClient) {}

    /** Returns the review requests and the user's open pull requests that need an action, for the Dashboard. */
    async dashboardPullRequests(owners: string[] | 'all' | undefined): Promise<DashboardPullRequests> {
        const scope = `${ownerQualifiers(owners)} archived:false is:pr`.trim();
        const [review, mine] = await Promise.all([
            this.dashboardSearch(`${scope} is:open draft:false review-requested:@me sort:updated-desc`, 100),
            this.dashboardSearch(`${scope} is:open author:@me sort:updated-desc`, 100)
        ]);
        return {
            reviewRequests: review.prs.map(pr => ({
                repo: dashboardRepo(pr),
                number: pr.number,
                title: pr.title,
                url: pr.url,
                author: pr.author?.login ?? null,
                updatedAt: pr.updatedAt,
                createdAt: pr.createdAt
            })),
            myPullRequests: mine.prs
                .map(pr => ({
                    repo: dashboardRepo(pr),
                    number: pr.number,
                    title: pr.title,
                    url: pr.url,
                    updatedAt: pr.updatedAt,
                    reasons: myPullRequestReasons({ ...pr, checks: pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null })
                }))
                .filter(pr => pr.reasons.length > 0)
        };
    }

    /**
     * Returns the new comments for the Dashboard, on pull requests of the user or where the user commented or reviewed.
     * GitHub search is slow for these searches, so they come after the pull requests.
     */
    async dashboardComments(owners: string[] | 'all' | undefined): Promise<PullRequestCommentItem[]> {
        const since = new Date(Date.now() - DASHBOARD_WINDOW_DAYS * 24 * 3600 * 1000);
        const recent = `${ownerQualifiers(owners)} archived:false is:pr updated:>=${since.toISOString().slice(0, 10)} sort:updated-desc`.trim();
        const results = await Promise.all([
            this.dashboardSearch(`${recent} author:@me`, 30),
            this.dashboardSearch(`${recent} commenter:@me`, 30),
            this.dashboardSearch(`${recent} reviewed-by:@me`, 30)
        ]);
        const viewer = results[0].viewer;
        const involved = new Map<string, DashboardPr>();
        for (const pr of results.flatMap(result => result.prs)) {
            involved.set(pr.id, pr);
        }
        await this.loadDashboardComments([...involved.values()]);

        const comments = new Map<string, PullRequestCommentItem>();
        for (const pr of involved.values()) {
            const loaded = this.dashboardCommentCache.get(pr.id);
            if (!loaded) continue;
            const all = [
                ...loaded.comments.nodes.map(comment => ({ comment, path: undefined as string | undefined })),
                // A review with no text and no decision is only the container of its line comments.
                ...loaded.reviews.nodes
                    .filter(item => item.bodyText.trim() || item.state === 'APPROVED' || item.state === 'CHANGES_REQUESTED')
                    .map(comment => ({ comment, path: undefined as string | undefined })),
                ...loaded.reviewThreads.nodes.flatMap(thread => thread.comments.nodes.map(comment => ({ comment, path: thread.path })))
            ].map(({ comment, path }) => ({
                id: comment.id,
                author: comment.author?.login ?? null,
                isBot: comment.author?.__typename === 'Bot' || !!comment.author?.login.endsWith('[bot]'),
                createdAt: comment.createdAt,
                comment,
                path
            }));
            for (const { comment, path } of newComments(all, viewer, since)) {
                comments.set(comment.id, {
                    id: comment.id,
                    repo: dashboardRepo(pr),
                    number: pr.number,
                    prTitle: pr.title,
                    prUrl: pr.url,
                    author: comment.author!.login,
                    text: comment.bodyText,
                    html: comment.bodyHTML,
                    createdAt: comment.createdAt,
                    url: comment.url,
                    path,
                    reviewState: comment.state,
                    prState: pr.state
                });
            }
        }
        return [...comments.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    private async dashboardSearch(q: string, first: number): Promise<{ viewer: string; prs: DashboardPr[] }> {
        const data = await this.client.graphql<{ viewer: { login: string }; search: { nodes: (DashboardPr | Record<string, never>)[] } }>(dashboardSearch(first), { q });
        return { viewer: data.viewer.login, prs: data.search.nodes.filter((node): node is DashboardPr => 'number' in node) };
    }

    /**
     * Loads the comments of the pull requests that changed since the last load, 10 pull requests in each request.
     * A failed request fails the load. The pull requests of the batches that loaded keep their comments.
     * The comments of a pull request without a change come from memory, so a refresh is cheap.
     */
    private async loadDashboardComments(prs: DashboardPr[]): Promise<void> {
        const changed = prs.filter(pr => this.dashboardCommentCache.get(pr.id)?.updatedAt !== pr.updatedAt).map(pr => pr.id);
        const batches: string[][] = [];
        for (let index = 0; index < changed.length; index += DASHBOARD_COMMENTS_BATCH) {
            batches.push(changed.slice(index, index + DASHBOARD_COMMENTS_BATCH));
        }
        // Two requests at the same time. More can trigger the secondary rate limit of GitHub.
        let next = 0;
        await Promise.all([0, 1].map(async () => {
            while (next < batches.length) {
                const ids = batches[next++];
                const data = await this.client.graphql<{ nodes: (DashboardPrComments | null)[] }>(DASHBOARD_COMMENTS_QUERY, { ids });
                for (const node of data.nodes) {
                    if (node && 'comments' in node) {
                        this.dashboardCommentCache.set(node.id, node);
                    }
                }
            }
        }));
        // Forget pull requests that are not in the Dashboard searches any more.
        const current = new Set(prs.map(pr => pr.id));
        for (const id of this.dashboardCommentCache.keys()) {
            if (!current.has(id)) this.dashboardCommentCache.delete(id);
        }
    }
}
