import type { RepoRef } from '@shared/github';
import { myPullRequestReasons } from '@shared/dashboard';
import { checkSummary, commitsAfter, reviewGroup, type OpenPullRequest, type RepoPullRequests } from '@shared/review-queue';
import type { GitHubClient } from './github-client';

// The open pull requests of a repository, for the review queue of the Review view.

export const REPO_PULL_REQUESTS_QUERY = `query($owner: String!, $name: String!, $q: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pushedAt
    pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes {
        id number title url isDraft createdAt updatedAt headRefName baseRefName headRefOid
        additions deletions changedFiles viewerDidAuthor reviewDecision mergeable mergeStateStatus
        author { login }
        comments { totalCount }
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
      }
    }
  }
  search(query: $q, type: ISSUE, first: 100) { nodes { ... on PullRequest { number } } }
}`;

export const SINCE_REVIEW_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id
      commits(last: 100) { nodes { commit { oid } } }
      reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { author { login } } } } }
    }
  }
}`;

interface GraphQlOpenPr {
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
    reviewDecision: string | null;
    mergeable: string;
    mergeStateStatus: string;
    author: { login: string } | null;
    comments: { totalCount: number };
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

export function openPullRequest(node: GraphQlOpenPr, reviewRequested: boolean): OpenPullRequest {
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
        actions: node.viewerDidAuthor ? myPullRequestReasons({ ...node, checks: rollup?.state ?? null }) : []
    };
}

/**
 * Returns the open pull requests of a repository (up to 100, the newest update first) for the Review view.
 * For each pull request, it tells if GitHub asks the viewer for a review, the last review of the viewer and the checks.
 * For a pull request to review again, it also counts the new commits and the resolved threads of the viewer.
 */
export async function fetchRepoPullRequests(client: GitHubClient, repo: RepoRef): Promise<RepoPullRequests> {
    const data = await client.graphql<{
        viewer: { login: string };
        repository: { pushedAt: string | null; pullRequests: { totalCount: number; nodes: GraphQlOpenPr[] } } | null;
        search: { nodes: ({ number: number } | Record<string, never>)[] };
    }>(REPO_PULL_REQUESTS_QUERY, {
        owner: repo.owner,
        name: repo.name,
        q: `repo:${repo.owner}/${repo.name} is:pr is:open draft:false review-requested:@me`
    });
    if (!data.repository) {
        throw new Error(`The repository ${repo.owner}/${repo.name} does not exist, or the token cannot read it.`);
    }
    const viewer = data.viewer.login;
    const requested = new Set(data.search.nodes.flatMap(node => ('number' in node ? [node.number] : [])));
    const prs = data.repository.pullRequests.nodes.map(node => openPullRequest(node, requested.has(node.number)));

    // The changes after the last review of the viewer, for the pull requests to review again. 20 pull requests in each request.
    const reviewed = prs.filter(pr => reviewGroup(pr) === 're-review');
    for (let index = 0; index < reviewed.length; index += 20) {
        const batch = reviewed.slice(index, index + 20);
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
    }
    return { viewer, openCount: data.repository.pullRequests.totalCount, pushedAt: data.repository.pushedAt ?? undefined, pullRequests: prs };
}
