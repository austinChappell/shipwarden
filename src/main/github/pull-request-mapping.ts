import {
    canManagePullRequests,
    canMergePullRequests,
    signedImageUrls,
    withEmoji,
    withSignedImages,
    type BranchSummary,
    type GitHubLabel,
    type MergedPullRequest,
    type GitHubUser,
    type MergeMethod,
    type PullRequest,
    type PullRequestCommit,
    type PullRequestSummary,
    type Reaction,
    type ReactionContent,
    type RepoRef,
    type RequestedReviewer,
    type TimelineEvent
} from '@shared/github';
import { reviewStatusOf, uniqueLogins, type ReviewStatus } from '@shared/review-queue';

/** The GraphQL fields of the reactions of a comment or a review. */
const REACTION_FIELDS = 'reactionGroups { content viewerHasReacted reactors { totalCount } }';

export const PULL_REQUEST_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
    autoMergeAllowed
    viewerDefaultMergeMethod
    viewerPermission
    pullRequest(number: $number) {
      id number title body bodyHTML url state isDraft mergeable mergeStateStatus reviewDecision
      author { login avatarUrl }
      baseRefName headRefName isCrossRepository baseRefOid headRefOid additions deletions changedFiles createdAt viewerDidAuthor viewerCanUpdate
      viewerCanEnableAutoMerge viewerCanDisableAutoMerge
      autoMergeRequest { mergeMethod enabledBy { login } }
      assignees(first: 20) { nodes { login avatarUrl } }
      labels(first: 50) { nodes { name color description } }
      reviewRequests(first: 30) {
        nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug name } ... on Bot { login } ... on Mannequin { login } } }
      }
      reviews(last: 30) { nodes { id author { login avatarUrl } state body bodyHTML submittedAt url ${REACTION_FIELDS} } }
      comments(last: 50) { nodes { id author { login avatarUrl } body bodyHTML createdAt url ${REACTION_FIELDS} } }
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line originalLine startLine originalStartLine diffSide
          comments(first: 50) { nodes { id databaseId author { login avatarUrl } body bodyHTML createdAt url diffHunk pullRequestReview { id } ${REACTION_FIELDS} } }
        }
      }
      commits(last: 100) {
        totalCount
        nodes { commit { oid abbreviatedOid messageHeadline committedDate url author { name user { login } } } }
      }
      headCommit: commits(last: 1) { nodes { commit { statusCheckRollup { contexts { totalCount } } } } }
    }
  }
}`;

/** One reaction group of GitHub. GitHub gives a group for each reaction, also with no users. */
export interface GraphQlReactionGroup {
    content: ReactionContent;
    viewerHasReacted: boolean;
    reactors: { totalCount: number };
}

/** A comment or a review in the GraphQL data: the shared type with the HTML and the reaction groups of GitHub. */
type GraphQlItem<T> = Omit<T, 'reactions'> & { bodyHTML: string; reactionGroups?: GraphQlReactionGroup[] | null };

/** Changes the reaction groups of GitHub to the reactions with one or more users. */
export function mapReactions(groups: readonly GraphQlReactionGroup[] | null | undefined): Reaction[] {
    return (groups ?? [])
        .filter(group => group.reactors.totalCount > 0)
        .map(group => ({ content: group.content, count: group.reactors.totalCount, viewerHasReacted: group.viewerHasReacted }));
}

type GraphQlReviewer = { __typename: string; login?: string; slug?: string; name?: string } | null;

export interface GraphQlPullRequest {
    viewer: { login: string };
    repository: {
        mergeCommitAllowed: boolean;
        squashMergeAllowed: boolean;
        rebaseMergeAllowed: boolean;
        autoMergeAllowed: boolean;
        viewerDefaultMergeMethod: 'MERGE' | 'SQUASH' | 'REBASE';
        viewerPermission: string | null;
        pullRequest:
            | (Omit<
                  PullRequest,
                  | 'reviews'
                  | 'issueComments'
                  | 'threads'
                  | 'allowedMergeMethods'
                  | 'defaultMergeMethod'
                  | 'commits'
                  | 'commitCount'
                  | 'checkCount'
                  | 'assignees'
                  | 'labels'
                  | 'reviewRequests'
                  | 'viewerCanManage'
                  | 'viewerCanMerge'
                  | 'autoMerge'
              > & {
                  autoMergeRequest: { mergeMethod: 'MERGE' | 'SQUASH' | 'REBASE'; enabledBy: { login: string } | null } | null;
                  bodyHTML: string;
                  assignees: { nodes: GitHubUser[] };
                  labels: { nodes: GitHubLabel[] };
                  reviewRequests: { nodes: { requestedReviewer: GraphQlReviewer }[] };
                  commits: {
                      totalCount: number;
                      nodes: { commit: Omit<PullRequestCommit, 'author'> & { author: { name: string | null; user: { login: string } | null } | null } }[];
                  };
                  headCommit: { nodes: { commit: { statusCheckRollup: { contexts: { totalCount: number } } | null } }[] };
                  reviews: { nodes: GraphQlItem<PullRequest['reviews'][number]>[] };
                  comments: { nodes: GraphQlItem<PullRequest['issueComments'][number]>[] };
                  reviewThreads: {
                      nodes: (Omit<PullRequest['threads'][number], 'comments' | 'side'> & {
                          diffSide: 'LEFT' | 'RIGHT';
                          comments: {
                              nodes: (Omit<GraphQlItem<PullRequest['threads'][number]['comments'][number]>, 'reviewId'> & {
                                  pullRequestReview?: { id: string } | null;
                              })[];
                          };
                      })[];
                  };
              })
            | null;
    };
}

/** Returns the merge methods that the repository allows, in the order merge, squash, rebase. */
export function allowedMergeMethods(
    repository: Pick<GraphQlPullRequest['repository'], 'mergeCommitAllowed' | 'squashMergeAllowed' | 'rebaseMergeAllowed'>
): MergeMethod[] {
    const allowed: MergeMethod[] = [];
    if (repository.mergeCommitAllowed) allowed.push('merge');
    if (repository.squashMergeAllowed) allowed.push('squash');
    if (repository.rebaseMergeAllowed) allowed.push('rebase');
    return allowed;
}

/** Changes the requested reviewers of GitHub to users and teams. It ignores a reviewer without a name. */
export function mapReviewRequests(nodes: { requestedReviewer: GraphQlReviewer }[]): RequestedReviewer[] {
    return nodes.flatMap(({ requestedReviewer: reviewer }): RequestedReviewer[] => {
        if (reviewer?.__typename === 'Team' && reviewer.slug) return [{ kind: 'team', login: reviewer.slug, name: reviewer.name }];
        if (reviewer?.login) return [{ kind: 'user', login: reviewer.login }];
        return [];
    });
}

/** Changes the GraphQL data of a pull request to the shared type. It throws an error when the pull request does not exist. */
export function mapPullRequest(data: GraphQlPullRequest, repo: RepoRef, number: number, timeline: TimelineEvent[] | undefined): PullRequest {
    const pr = data.repository.pullRequest;
    if (!pr) {
        throw new Error(`Pull request #${number} does not exist in ${repo.owner}/${repo.name}.`);
    }
    const { commits, headCommit, bodyHTML, comments: issueComments, assignees, labels, reviewRequests, autoMergeRequest, ...rest } = pr;
    // Images of private repositories need the signed URLs from the HTML that GitHub rendered.
    const html = [
        bodyHTML,
        ...pr.reviews.nodes.map(review => review.bodyHTML),
        ...issueComments.nodes.map(comment => comment.bodyHTML),
        ...pr.reviewThreads.nodes.flatMap(thread => thread.comments.nodes.map(comment => comment.bodyHTML))
    ];
    const images = signedImageUrls(html);
    // The Markdown has emoji shortcodes such as :warning:. GitHub shows them as emoji.
    const render = (body: string) => withEmoji(withSignedImages(body, images));
    const sign = <T extends { body: string; bodyHTML: string; reactionGroups?: GraphQlReactionGroup[] | null }>({
        bodyHTML: _html,
        reactionGroups,
        ...item
    }: T): Omit<T, 'bodyHTML' | 'reactionGroups'> & { reactions: Reaction[] } => ({
        ...item,
        body: render(item.body),
        reactions: mapReactions(reactionGroups)
    });
    return {
        ...rest,
        body: render(pr.body),
        commits: commits.nodes.map(({ commit: { author, ...commit } }) => ({ ...commit, author: author?.user?.login ?? author?.name ?? null })),
        commitCount: commits.totalCount,
        checkCount: headCommit.nodes[0]?.commit.statusCheckRollup?.contexts.totalCount ?? 0,
        reviews: pr.reviews.nodes.map(sign),
        issueComments: issueComments.nodes.map(sign),
        threads: pr.reviewThreads.nodes.map(({ diffSide, comments, ...thread }) => ({
            ...thread,
            side: diffSide,
            comments: comments.nodes.map(({ pullRequestReview, ...comment }) => ({
                ...sign(comment),
                ...(pullRequestReview ? { reviewId: pullRequestReview.id } : {})
            }))
        })),
        allowedMergeMethods: allowedMergeMethods(data.repository),
        defaultMergeMethod: data.repository.viewerDefaultMergeMethod.toLowerCase() as MergeMethod,
        assignees: assignees.nodes,
        labels: labels.nodes,
        reviewRequests: mapReviewRequests(reviewRequests.nodes),
        // A request to a team of the user does not count. The query does not get the teams of the user.
        viewerIsRequested: reviewRequests.nodes.some(
            ({ requestedReviewer: reviewer }) => reviewer?.__typename === 'User' && reviewer.login === data.viewer?.login
        ),
        viewerCanManage: canManagePullRequests(data.repository.viewerPermission),
        viewerCanMerge: canMergePullRequests(data.repository.viewerPermission),
        autoMerge: autoMergeRequest
            ? { method: autoMergeRequest.mergeMethod.toLowerCase() as MergeMethod, enabledBy: autoMergeRequest.enabledBy?.login ?? null }
            : null,
        viewerCanEnableAutoMerge: data.repository.autoMergeAllowed && pr.viewerCanEnableAutoMerge,
        viewerCanDisableAutoMerge: pr.viewerCanDisableAutoMerge,
        timeline
    };
}

export const BRANCH_SUMMARIES_QUERY = `query($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title url isDraft headRefName headRefOid reviewDecision isCrossRepository viewerDidAuthor
        assignees(first: 10) { nodes { login } }
        reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } } } }
        participants(first: 30) { nodes { login } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

/** The query for the merged pull requests of a repository, the most recently updated first. */
export const MERGED_BRANCHES_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number title headRefName headRefOid isCrossRepository }
    }
  }
}`;

/** The fields of an open pull request for the worktree list. */
const BRANCH_PULL_REQUEST_FIELDS = `number title url isDraft headRefName headRefOid reviewDecision isCrossRepository viewerDidAuthor
        headRepositoryOwner { login }
        assignees(first: 10) { nodes { login } }
        reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } } } }
        participants(first: 30) { nodes { login } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

/**
 * The query for the open pull requests of the user from a fork to its parent. A search finds them also in a parent
 * with many open pull requests. The search string has the repository and "author:@me".
 */
export const FORK_BRANCH_SUMMARIES_QUERY = `query($search: String!) {
  viewer { login }
  search(query: $search, type: ISSUE, first: 100) {
    nodes { ... on PullRequest { ${BRANCH_PULL_REQUEST_FIELDS} } }
  }
}`;

/** The query for the merged pull requests of the user from a fork to its parent. */
export const FORK_MERGED_BRANCHES_QUERY = `query($search: String!) {
  search(query: $search, type: ISSUE, first: 100) {
    nodes { ... on PullRequest { number title headRefName headRefOid isCrossRepository headRepositoryOwner { login } } }
  }
}`;

/** The GraphQL data of a search for pull requests. A node that is not a pull request has no fields. */
export interface GraphQlSearch<T> {
    viewer?: { login: string };
    search: { nodes: (Partial<T> | null)[] };
}

/** Returns the pull requests of a search. It removes the nodes that are not pull requests. */
export function searchNodes<T extends { number: number }>(data: GraphQlSearch<T>): T[] {
    return data.search.nodes.filter((node): node is T => typeof node?.number === 'number');
}

/**
 * Returns true when a pull request is from a branch of the worktree's repository.
 * Without `headOwner`, the branch is in the same repository. With `headOwner`, the branch is in the fork of that owner.
 */
function isOwnBranch(pr: { isCrossRepository: boolean; headRepositoryOwner?: { login: string } | null }, headOwner?: string): boolean {
    if (!headOwner) return !pr.isCrossRepository;
    return pr.isCrossRepository && pr.headRepositoryOwner?.login.toLowerCase() === headOwner.toLowerCase();
}

/** The fields of a merged pull request in the query for the worktree list. */
export interface GraphQlMergedPullRequest {
    number: number;
    title: string;
    headRefName: string;
    headRefOid: string;
    isCrossRepository: boolean;
    headRepositoryOwner?: { login: string } | null;
}

export interface GraphQlMergedBranches {
    repository: { pullRequests: { nodes: GraphQlMergedPullRequest[] } };
}

/**
 * Returns the newest merged pull request of each branch. A pull request from another fork is not the pull request of a
 * local branch. With `headOwner`, only the pull requests from the fork of that owner count.
 */
export function mapMergedBranches(data: GraphQlMergedBranches, headOwner?: string): Record<string, MergedPullRequest> {
    const merged: Record<string, MergedPullRequest> = {};
    for (const pr of data.repository.pullRequests.nodes) {
        if (!isOwnBranch(pr, headOwner) || merged[pr.headRefName]) continue;
        merged[pr.headRefName] = { number: pr.number, title: pr.title, headSha: pr.headRefOid };
    }
    return merged;
}

/** The fields of an open pull request in the query for the worktree list. */
export interface GraphQlBranchPullRequest {
    number: number;
    title: string;
    url: string;
    isDraft: boolean;
    headRefName: string;
    headRefOid: string;
    reviewDecision: BranchSummary['reviewDecision'];
    isCrossRepository: boolean;
    headRepositoryOwner?: { login: string } | null;
    viewerDidAuthor: boolean;
    assignees: { nodes: { login: string }[] };
    reviewRequests: { nodes: { requestedReviewer: { login?: string } | null }[] };
    participants: { nodes: { login: string }[] };
    commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

export interface GraphQlBranchSummaries {
    viewer: { login: string };
    repository: { pullRequests: { nodes: GraphQlBranchPullRequest[] } };
}

/**
 * Returns the open pull requests by head branch. The first pull request of a branch wins.
 * With `headOwner`, only the pull requests from the fork of that owner count.
 */
export function mapBranchSummaries(data: GraphQlBranchSummaries, headOwner?: string): Record<string, BranchSummary> {
    const viewer = data.viewer.login;
    const summaries: Record<string, BranchSummary> = {};
    for (const pr of data.repository.pullRequests.nodes) {
        // A pull request from another fork can have the same branch name as a local branch. It is not the worktree's PR.
        if (!isOwnBranch(pr, headOwner) || summaries[pr.headRefName]) {
            continue;
        }
        summaries[pr.headRefName] = {
            number: pr.number,
            title: pr.title,
            url: pr.url,
            headSha: pr.headRefOid,
            isDraft: pr.isDraft,
            reviewDecision: pr.reviewDecision,
            checks: pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
            viewerRole: githubViewerRole(viewer, pr)
        };
    }
    return summaries;
}

/** Returns the relation of the viewer to a pull request. Participants are the author, the reviewers and the commenters. */
export function githubViewerRole(
    viewer: string,
    pr: {
        viewerDidAuthor: boolean;
        assignees: { nodes: { login: string }[] };
        reviewRequests: { nodes: { requestedReviewer: { login?: string } | null }[] };
        participants: { nodes: { login: string }[] };
    }
): BranchSummary['viewerRole'] {
    if (pr.viewerDidAuthor) return 'author';
    const involved =
        pr.assignees.nodes.some(user => user.login === viewer) ||
        pr.reviewRequests.nodes.some(request => request.requestedReviewer?.login === viewer) ||
        pr.participants.nodes.some(user => user.login === viewer);
    return involved ? 'involved' : undefined;
}

/** The fields of a pull request in a search result of the Review view. */
/** The GraphQL fields of the assignees, the reviewers, and the review status of a pull request in a list. */
export const PEOPLE_FIELDS = `assignees(first: 10) { nodes { login } }
        reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { combinedSlug } } } }
        latestReviews(first: 20) { nodes { state author { login } } }`;

export interface GraphQlPeople {
    reviewDecision: string | null;
    author: { login: string } | null;
    assignees?: { nodes: { login: string }[] };
    reviewRequests?: { nodes: { requestedReviewer: { __typename?: string; login?: string; combinedSlug?: string } | null }[] };
    latestReviews?: { nodes: { state: string; author: { login: string } | null }[] };
}

/**
 * Returns the assignees, the reviewers, and the review status of a pull request.
 * The reviewers are the requested users and teams, and the people who reviewed. A comment of the author on the own pull request is not a review.
 */
export function pullRequestPeople(node: GraphQlPeople): { assignees: string[]; reviewers: string[]; reviewStatus: ReviewStatus } {
    const author = node.author?.login.toLowerCase();
    const reviews = (node.latestReviews?.nodes ?? []).filter(review => review.author && review.author.login.toLowerCase() !== author);
    const requested = (node.reviewRequests?.nodes ?? []).map(item => item.requestedReviewer?.login ?? item.requestedReviewer?.combinedSlug ?? '');
    return {
        assignees: uniqueLogins([(node.assignees?.nodes ?? []).map(item => item.login)]),
        reviewers: uniqueLogins([requested, reviews.map(review => review.author?.login ?? '')]),
        reviewStatus: reviewStatusOf(
            node.reviewDecision,
            reviews.map(review => review.state)
        )
    };
}

export interface GraphQlSummary extends GraphQlPeople {
    number: number;
    title: string;
    isDraft: boolean;
    state: PullRequestSummary['state'];
    updatedAt: string;
    reviewDecision: PullRequestSummary['reviewDecision'];
    additions: number;
    deletions: number;
    viewerDidAuthor: boolean;
    comments: { totalCount: number };
    commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

/** Changes the search nodes of the Review view to summaries. It ignores a node that is not a pull request. */
export function mapPullRequestSummaries(nodes: (GraphQlSummary | Record<string, never>)[]): PullRequestSummary[] {
    return nodes
        .filter((node): node is GraphQlSummary => 'number' in node)
        .map(node => ({
            number: node.number,
            title: node.title,
            author: node.author?.login ?? null,
            isDraft: node.isDraft,
            state: node.state,
            updatedAt: node.updatedAt,
            reviewDecision: node.reviewDecision,
            checks: node.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null,
            comments: node.comments.totalCount,
            additions: node.additions,
            deletions: node.deletions,
            viewerDidAuthor: node.viewerDidAuthor,
            ...pullRequestPeople(node)
        }));
}
