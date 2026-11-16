import type { RepoRef } from '@shared/github';
import { myPullRequestReasons } from '@shared/dashboard';
import { checkSummary, commitsAfter, lastActivityOf, reviewGroup, type OpenPullRequest, type RepoPullRequests } from '@shared/review-queue';
import type { GitHubClient } from './github-client';
import { PEOPLE_FIELDS, pullRequestPeople, type GraphQlPeople } from './pull-request-mapping';

// The open pull requests of a repository, for the review queue of the Review view.

/**
 * The number of the most recently updated open pull requests in the list. GitHub calculates the fields of each pull request
 * slowly. In a busy repository, a list of 100 passes the time limit of GitHub (502).
 */
export const RECENT_LIMIT = 30;

/**
 * The fields of an open pull request. They do not include `mergeable` and `mergeStateStatus`, because GitHub calculates them slowly.
 * Only the search for the pull requests of the viewer asks for `mergeable`.
 */
const OPEN_PR_FIELDS = `fragment OpenPr on PullRequest {
  id number title url isDraft createdAt updatedAt headRefName baseRefName headRefOid
  additions deletions changedFiles viewerDidAuthor reviewDecision
  author { login }
  ${PEOPLE_FIELDS}
  comments(last: 10) { totalCount nodes { createdAt author { __typename login } } }
  reviews(last: 10) { nodes { submittedAt author { __typename login } } }
  viewerLatestReview { state submittedAt commit { oid } }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
          contexts(first: 1) { checkRunCountsByState { state count } statusContextCountsByState { state count } }
        }
      }
    }
  }
}`;

/**
 * The open pull requests of a repository: the most recently updated ones, and the ones that involve the viewer.
 * The searches find older pull requests for the review queue that the recent list does not contain.
 */
export const REPO_PULL_REQUESTS_QUERY = `query($owner: String!, $name: String!, $requested: String!, $reviewed: String!, $mine: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pushedAt
    pullRequests(states: OPEN, first: ${RECENT_LIMIT}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes { ...OpenPr }
    }
  }
  requested: search(query: $requested, type: ISSUE, first: 50) { nodes { ... on PullRequest { ...OpenPr } } }
  reviewed: search(query: $reviewed, type: ISSUE, first: 30) { nodes { ... on PullRequest { ...OpenPr } } }
  mine: search(query: $mine, type: ISSUE, first: 30) { nodes { ... on PullRequest { ...OpenPr mergeable } } }
}
${OPEN_PR_FIELDS}`;

export const SINCE_REVIEW_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id
      commits(last: 100) { nodes { commit { oid } } }
      reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { author { login } } } } }
    }
  }
}`;

export interface GraphQlOpenPr extends GraphQlPeople {
    id: string;
    number: number;
    title: string;
    url: string;
    isDraft: boolean;
    createdAt: string;
    updatedAt: string;
    headRefName: string;
    baseRefName: string;
    headRefOid: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    viewerDidAuthor: boolean;
    /** Only the pull requests of the viewer have this field. */
    mergeable?: string;
    comments: { totalCount: number; nodes?: { createdAt: string; author: { __typename?: string; login: string } | null }[] };
    reviews?: { nodes: { submittedAt: string | null; author: { __typename?: string; login: string } | null }[] };
    viewerLatestReview: { state: string; submittedAt: string | null; commit: { oid: string } | null } | null;
    commits: {
        nodes: {
            commit: {
                statusCheckRollup: {
                    state: string;
                    contexts: {
                        checkRunCountsByState: { state: string; count: number }[] | null;
                        statusContextCountsByState: { state: string; count: number }[] | null;
                    };
                } | null;
            };
        }[];
    };
}

interface GraphQlSinceReview {
    id: string;
    commits: { nodes: { commit: { oid: string } }[] };
    reviewThreads: { nodes: { isResolved: boolean; comments: { nodes: { author: { login: string } | null }[] } }[] };
}

/** Makes an open pull request. `viewer` is the login of the viewer. Comments and reviews of the viewer are not new activity. */
export function openPullRequest(node: GraphQlOpenPr, reviewRequested: boolean, viewer = ''): OpenPullRequest {
    const rollup = node.commits.nodes[0]?.commit.statusCheckRollup ?? null;
    const checks = checkSummary(rollup?.state ?? null, [
        ...(rollup?.contexts.checkRunCountsByState ?? []),
        ...(rollup?.contexts.statusContextCountsByState ?? [])
    ]);
    const review = node.viewerLatestReview;
    return {
        id: node.id,
        number: node.number,
        title: node.title,
        url: node.url,
        author: node.author?.login ?? null,
        isDraft: node.isDraft,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        headRefName: node.headRefName,
        baseRefName: node.baseRefName,
        headRefOid: node.headRefOid,
        additions: node.additions,
        deletions: node.deletions,
        changedFiles: node.changedFiles,
        comments: node.comments.totalCount,
        viewerDidAuthor: node.viewerDidAuthor,
        reviewRequested,
        reviewDecision: node.reviewDecision,
        checks,
        // A pending review is a draft of the viewer. It is not a review yet.
        viewerReview:
            review && review.state !== 'PENDING' && review.submittedAt
                ? { state: review.state, submittedAt: review.submittedAt, commitOid: review.commit?.oid ?? null }
                : undefined,
        lastActivityAt: lastActivityOf(viewer, [
            ...(node.comments.nodes ?? []).map(item => ({ at: item.createdAt, author: item.author })),
            ...(node.reviews?.nodes ?? []).map(item => ({ at: item.submittedAt, author: item.author }))
        ]),
        actions: node.viewerDidAuthor ? myPullRequestReasons({ ...node, mergeable: node.mergeable ?? 'UNKNOWN', checks: rollup?.state ?? null }) : [],
        ...pullRequestPeople(node)
    };
}

type SearchNodes = { nodes: (GraphQlOpenPr | Record<string, never>)[] };

function searchPrs(result: SearchNodes): GraphQlOpenPr[] {
    return result.nodes.filter((node): node is GraphQlOpenPr => 'number' in node);
}

/**
 * Joins the recent pull requests and the pull requests of the searches. A pull request of a search replaces the same pull
 * request of the recent list, because only the search for the pull requests of the viewer has `mergeable`.
 * The newest update comes first.
 */
export function joinOpenPullRequests(recent: GraphQlOpenPr[], searched: GraphQlOpenPr[]): GraphQlOpenPr[] {
    const byNumber = new Map<number, GraphQlOpenPr>();
    for (const node of [...recent, ...searched]) byNumber.set(node.number, { ...byNumber.get(node.number), ...node });
    return [...byNumber.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Returns the open pull requests of a repository for the Review view: the 30 most recently updated ones, and the ones where
 * GitHub asks the viewer for a review, the viewer reviewed or the viewer is the author. The newest update comes first.
 * For each pull request, it tells if GitHub asks the viewer for a review, the last review of the viewer and the checks.
 * For a pull request to review again, it also counts the new commits and the resolved threads of the viewer.
 */
export async function fetchRepoPullRequests(client: GitHubClient, repo: RepoRef): Promise<RepoPullRequests> {
    const scope = `repo:${repo.owner}/${repo.name} is:pr is:open sort:updated-desc`;
    const data = await client.graphql<{
        viewer: { login: string };
        repository: { pushedAt: string | null; pullRequests: { totalCount: number; nodes: GraphQlOpenPr[] } } | null;
        requested: SearchNodes;
        reviewed: SearchNodes;
        mine: SearchNodes;
    }>(REPO_PULL_REQUESTS_QUERY, {
        owner: repo.owner,
        name: repo.name,
        requested: `${scope} draft:false review-requested:@me`,
        reviewed: `${scope} reviewed-by:@me -author:@me`,
        mine: `${scope} author:@me`
    });
    if (!data.repository) {
        throw new Error(`The repository ${repo.owner}/${repo.name} does not exist, or the token cannot read it.`);
    }
    const viewer = data.viewer.login;
    const requestedPrs = searchPrs(data.requested);
    const requested = new Set(requestedPrs.map(node => node.number));
    const nodes = joinOpenPullRequests(data.repository.pullRequests.nodes, [...requestedPrs, ...searchPrs(data.reviewed), ...searchPrs(data.mine)]);
    const prs = nodes.map(node => openPullRequest(node, requested.has(node.number), viewer));

    // The changes after the last review of the viewer, for the pull requests to review again. 20 pull requests in each request.
    // The requests run at the same time. Usually there is only one.
    // The main process does not know the seen activity, so this list can contain pull requests that the viewer marked as seen.
    const reviewed = prs.filter(pr => reviewGroup(pr) === 're-review');
    const batches: OpenPullRequest[][] = [];
    for (let index = 0; index < reviewed.length; index += 20) batches.push(reviewed.slice(index, index + 20));
    await Promise.all(
        batches.map(async batch => {
            const details = await client.graphql<{ nodes: (GraphQlSinceReview | null)[] }>(SINCE_REVIEW_QUERY, { ids: batch.map(pr => pr.id) });
            const byId = new Map(details.nodes.filter((node): node is GraphQlSinceReview => !!node && 'commits' in node).map(node => [node.id, node]));
            for (const pr of batch) {
                const node = byId.get(pr.id);
                if (!node) continue;
                const own = node.reviewThreads.nodes.filter(thread => thread.comments.nodes[0]?.author?.login.toLowerCase() === viewer.toLowerCase());
                pr.sinceReview = {
                    newCommits: commitsAfter(
                        node.commits.nodes.map(item => item.commit.oid),
                        pr.viewerReview!.commitOid
                    ),
                    threads: own.length,
                    resolved: own.filter(thread => thread.isResolved).length
                };
            }
        })
    );
    return { viewer, openCount: data.repository.pullRequests.totalCount, pushedAt: data.repository.pushedAt ?? undefined, pullRequests: prs };
}
