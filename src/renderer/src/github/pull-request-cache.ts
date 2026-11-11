import type { QueryClient } from '@tanstack/react-query';
import type { DashboardPullRequests, PullRequestCommentItem } from '@shared/dashboard';
import {
    reactionKinds,
    toggledReactions,
    type BranchSummary,
    type GitHubLabel,
    type GitHubUser,
    type PullRequest,
    type PullRequestChange,
    type ReactionContent,
    type ReviewComment,
    type ReviewDecision,
    type ReviewEvent
} from '@shared/github';
import type { RepoPullRequests } from '@shared/review-queue';
import { applyMetaChanges } from '../components/pr-meta-changes';
import { keyRoots } from '../query-client';

/*
 * A change to a pull request updates the cached data directly. The views then show the change without a new request.
 * The functions here are pure, except the functions that get a QueryClient.
 * The next load from the host (after the stale time) replaces the local data with the data of the host.
 */

/** A review that the user submitted. The lists of the Review view and the Dashboard use it. */
export interface SubmittedReview {
    /** The review state, for example APPROVED or COMMENTED. */
    state: string;
    submittedAt: string;
}

/** The review state of each review event, as the host shows the review. */
const REVIEW_STATE: Record<ReviewEvent, string> = {
    APPROVE: 'APPROVED',
    REQUEST_CHANGES: 'CHANGES_REQUESTED',
    COMMENT: 'COMMENTED',
    APPROVE_WITH_SUGGESTIONS: 'APPROVED_WITH_SUGGESTIONS',
    WAIT_FOR_AUTHOR: 'WAITING_FOR_AUTHOR',
    REJECT: 'REJECTED'
};

/** Returns the review state of a review event. */
export function reviewStateOf(event: ReviewEvent): string {
    return REVIEW_STATE[event];
}

/** True for a review event that approves the pull request. */
function approves(event: ReviewEvent): boolean {
    return event === 'APPROVE' || event === 'APPROVE_WITH_SUGGESTIONS';
}

/** True for a review event that blocks the pull request. */
function blocks(event: ReviewEvent): boolean {
    return event === 'REQUEST_CHANGES' || event === 'WAIT_FOR_AUTHOR' || event === 'REJECT';
}

/**
 * True for a review event that can change the merge state. The host calculates the merge state, for example the branch
 * rules and the permission to merge. The cache cannot know the new state.
 */
export function changesMergeState(event: ReviewEvent): boolean {
    return approves(event) || blocks(event);
}

/**
 * True when the merge state of the host can be old after a review. The host calculates the merge state some time after
 * the review. Until then, the state is UNKNOWN, or it does not agree with the review decision:
 * - The decision is APPROVED and the merge is BLOCKED.
 * - The decision is CHANGES_REQUESTED and the merge is CLEAN.
 * Other branch rules can also block a merge. Thus this function can be true for a correct state, and one more load is necessary.
 */
export function mergeStateMayBeOld(pr: PullRequest): boolean {
    if (pr.state !== 'OPEN') return false;
    if (pr.mergeable === 'UNKNOWN' || pr.mergeStateStatus === 'UNKNOWN') return true;
    if (pr.reviewDecision === 'APPROVED') return pr.mergeStateStatus === 'BLOCKED';
    if (pr.reviewDecision === 'CHANGES_REQUESTED') return pr.mergeStateStatus === 'CLEAN';
    return false;
}

/**
 * Returns the review decision after a review of the user.
 * A block always sets CHANGES_REQUESTED. An approval sets APPROVED, except when the decision is CHANGES_REQUESTED:
 * the changes request of another reviewer can still apply. A comment does not change the decision.
 * The host can need more approvals. The next load corrects the decision.
 */
export function decisionAfterReview(current: ReviewDecision, event: ReviewEvent): ReviewDecision {
    if (blocks(event)) return 'CHANGES_REQUESTED';
    if (approves(event)) return current === 'CHANGES_REQUESTED' ? current : 'APPROVED';
    return current;
}

/** Returns the pull request after a merge. */
export function mergedPullRequest(pr: PullRequest): PullRequest {
    return { ...pr, state: 'MERGED', autoMerge: null, viewerCanEnableAutoMerge: false, viewerCanDisableAutoMerge: false };
}

/**
 * Returns the pull request after a change. `knownLabels` gives the color of a new label.
 * `viewer` is the user that turns on auto-merge.
 */
export function changedPullRequest(pr: PullRequest, change: PullRequestChange, knownLabels: GitHubLabel[] = [], viewer?: GitHubUser | null): PullRequest {
    switch (change.kind) {
        case 'details': {
            const state = change.state === 'open' ? 'OPEN' : change.state === 'closed' ? 'CLOSED' : pr.state;
            return { ...pr, title: change.title ?? pr.title, body: change.body ?? pr.body, state };
        }
        case 'draft':
            return { ...pr, isDraft: change.draft };
        case 'autoMerge':
            return { ...pr, autoMerge: change.method ? { method: change.method, enabledBy: viewer?.login ?? null } : null };
        case 'assignee':
        case 'reviewer':
        case 'label':
            return { ...pr, ...applyMetaChanges(pr, [change], knownLabels) };
    }
}

/** Returns the pull request with a new comment at the end of a thread. */
export function withReply(pr: PullRequest, threadId: string, comment: ReviewComment): PullRequest {
    return {
        ...pr,
        threads: pr.threads.map(thread => (thread.id === threadId ? { ...thread, comments: [...thread.comments, comment] } : thread))
    };
}

/** Returns the pull request with a thread that is resolved or not resolved. */
export function withThreadResolved(pr: PullRequest, threadId: string, resolved: boolean): PullRequest {
    return { ...pr, threads: pr.threads.map(thread => (thread.id === threadId ? { ...thread, isResolved: resolved } : thread)) };
}

/**
 * Returns the pull request after the user adds (`on`) or removes a reaction. `subjectId` is the `id` of a review
 * comment, a comment of the conversation or a review.
 */
export function withReaction(pr: PullRequest, subjectId: string, content: ReactionContent, on: boolean): PullRequest {
    const kinds = reactionKinds(pr);
    const patch = <T extends { id: string; reactions?: PullRequest['issueComments'][number]['reactions'] }>(item: T): T =>
        item.id === subjectId ? { ...item, reactions: toggledReactions(item.reactions, content, on, kinds) } : item;
    return {
        ...pr,
        reviews: pr.reviews.map(patch),
        issueComments: pr.issueComments.map(patch),
        threads: pr.threads.map(thread =>
            thread.comments.some(comment => comment.id === subjectId) ? { ...thread, comments: thread.comments.map(patch) } : thread
        )
    };
}

/**
 * Returns the pull request after a review of the user. The review goes at the end of the reviews.
 * The host does not ask the user for a review after it.
 */
export function reviewedPullRequest(
    pr: PullRequest,
    review: { id: string; event: ReviewEvent; body: string; viewer: GitHubUser | null; submittedAt: string }
): PullRequest {
    const login = review.viewer?.login;
    return {
        ...pr,
        reviews: [
            ...pr.reviews,
            { id: review.id, author: review.viewer, state: reviewStateOf(review.event), body: review.body, submittedAt: review.submittedAt, url: pr.url }
        ],
        reviewDecision: decisionAfterReview(pr.reviewDecision, review.event),
        viewerIsRequested: pr.viewerIsRequested === undefined ? undefined : false,
        reviewRequests: login ? pr.reviewRequests.filter(item => !(item.kind === 'user' && item.login === login)) : pr.reviewRequests
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the value is a pull request with its threads, not a short item of a list. */
export function isPullRequest(value: unknown): value is PullRequest {
    return isObject(value) && typeof value.url === 'string' && Array.isArray(value.threads) && typeof value.headRefOid === 'string';
}

/** Returns the full pull request in a cached value: the value itself, or its `pullRequest` field (for example a BranchStatus). */
export function pullRequestIn(data: unknown): PullRequest | undefined {
    if (isPullRequest(data)) return data;
    return isObject(data) && isPullRequest(data.pullRequest) ? data.pullRequest : undefined;
}

/** Returns the branch summaries with the new state of a pull request. The summaries have only open pull requests. */
export function patchBranchSummaries(summaries: Record<string, BranchSummary>, next: PullRequest): Record<string, BranchSummary> {
    const entry = Object.entries(summaries).find(([, summary]) => summary.url === next.url);
    if (!entry) return summaries;
    const [branch, summary] = entry;
    if (next.state !== 'OPEN') {
        const { [branch]: _removed, ...rest } = summaries;
        return rest;
    }
    return { ...summaries, [branch]: { ...summary, title: next.title, isDraft: next.isDraft, reviewDecision: next.reviewDecision, headSha: next.headRefOid } };
}

/** Returns the open pull requests of a repository with the new state of a pull request. */
export function patchRepoPullRequests(data: RepoPullRequests, next: PullRequest, review?: SubmittedReview): RepoPullRequests {
    const index = data.pullRequests.findIndex(item => item.url === next.url);
    if (index < 0) return data;
    if (next.state !== 'OPEN') {
        return { ...data, openCount: Math.max(0, data.openCount - 1), pullRequests: data.pullRequests.filter((_item, at) => at !== index) };
    }
    const item = data.pullRequests[index];
    const patched = {
        ...item,
        title: next.title,
        isDraft: next.isDraft,
        reviewDecision: next.reviewDecision,
        ...(review ? { reviewRequested: false, viewerReview: { state: review.state, submittedAt: review.submittedAt, commitOid: next.headRefOid } } : {})
    };
    return { ...data, pullRequests: data.pullRequests.map((value, at) => (at === index ? patched : value)) };
}

/**
 * Returns the pull requests of the Dashboard with the new state of a pull request.
 * A pull request that is not open goes away. After a review of the user, the review request goes away.
 */
export function patchDashboardPullRequests(data: DashboardPullRequests, next: PullRequest, review?: SubmittedReview): DashboardPullRequests {
    if (!data.reviewRequests.some(item => item.url === next.url) && !data.myPullRequests.some(item => item.url === next.url)) return data;
    const open = next.state === 'OPEN';
    return {
        reviewRequests: data.reviewRequests
            .filter(item => item.url !== next.url || (open && !review))
            .map(item => (item.url === next.url ? { ...item, title: next.title } : item)),
        myPullRequests: data.myPullRequests
            .filter(item => item.url !== next.url || open)
            .map(item => (item.url === next.url ? { ...item, title: next.title } : item))
    };
}

/** Returns the comments of the Dashboard with the new state and title of their pull request. */
export function patchCommentItems(items: PullRequestCommentItem[], next: PullRequest): PullRequestCommentItem[] {
    if (!items.some(item => item.prUrl === next.url)) return items;
    return items.map(item => (item.prUrl === next.url ? { ...item, prState: next.state, prTitle: next.title } : item));
}

function isRepoPullRequests(data: unknown): data is RepoPullRequests {
    return isObject(data) && Array.isArray(data.pullRequests) && typeof data.openCount === 'number';
}

function isDashboardPullRequests(data: unknown): data is DashboardPullRequests {
    return isObject(data) && Array.isArray(data.reviewRequests) && Array.isArray(data.myPullRequests);
}

function isCommentItems(data: unknown): data is PullRequestCommentItem[] {
    return Array.isArray(data) && data.length > 0 && isObject(data[0]) && typeof data[0].prUrl === 'string';
}

/**
 * Puts the new state of a pull request into one cached value of any shape that shows it.
 * Returns the same value when the value does not show the pull request.
 */
export function patchCachedData(data: unknown, next: PullRequest, review?: SubmittedReview): unknown {
    if (isPullRequest(data)) return data.url === next.url ? next : data;
    if (isObject(data) && isPullRequest(data.pullRequest)) {
        return data.pullRequest.url === next.url ? { ...data, pullRequest: next, ...('sha' in data ? { sha: next.headRefOid } : {}) } : data;
    }
    if (isRepoPullRequests(data)) return patchRepoPullRequests(data, next, review);
    if (isDashboardPullRequests(data)) return patchDashboardPullRequests(data, next, review);
    if (isCommentItems(data)) return patchCommentItems(data, next);
    return data;
}

/** The roots of the queries that keep a full pull request. */
const DETAIL_ROOTS = [keyRoots.pullRequest, keyRoots.branchStatus];
/** The roots of the queries that show a pull request in a list. The branch summaries have their own function. */
const LIST_ROOTS = [keyRoots.repoPullRequests, keyRoots.dashboard];

/** Returns the newest cached copy of a pull request, or undefined when no query has it. */
export function cachedPullRequest(client: QueryClient, url: string): PullRequest | undefined {
    let newest: { pr: PullRequest; at: number } | undefined;
    for (const queryKey of DETAIL_ROOTS) {
        for (const query of client.getQueryCache().findAll({ queryKey })) {
            const pr = pullRequestIn(query.state.data);
            if (pr?.url === url && (!newest || query.state.dataUpdatedAt > newest.at)) {
                newest = { pr, at: query.state.dataUpdatedAt };
            }
        }
    }
    return newest?.pr;
}

/**
 * Applies a change to the newest cached copy of a pull request (or to `base` when no query has it), and puts the result
 * into each cached query that shows the pull request. Returns the new pull request.
 */
export function writePullRequest(client: QueryClient, base: PullRequest, change: (pr: PullRequest) => PullRequest, review?: SubmittedReview): PullRequest {
    const next = change(cachedPullRequest(client, base.url) ?? base);
    for (const queryKey of [...DETAIL_ROOTS, ...LIST_ROOTS]) {
        client.setQueriesData({ queryKey }, (data: unknown) => (data === undefined ? undefined : patchCachedData(data, next, review)));
    }
    client.setQueriesData({ queryKey: keyRoots.branchSummaries }, (data: Record<string, BranchSummary> | undefined) =>
        data === undefined ? undefined : patchBranchSummaries(data, next)
    );
    return next;
}

/**
 * Marks the cached copies of one pull request as stale. The copies that show now load again.
 * Use it only when the new data of the pull request cannot be known here.
 */
export function invalidatePullRequest(client: QueryClient, url: string): Promise<void> {
    return Promise.all(
        DETAIL_ROOTS.map(queryKey => client.invalidateQueries({ queryKey, predicate: query => pullRequestIn(query.state.data)?.url === url }))
    ).then(() => undefined);
}

/**
 * Returns the signed-in user, as far as the cache knows it: the author of an own pull request, or the viewer of the
 * cached list of the repository. Returns null when the cache does not know the user.
 */
export function viewerOf(client: QueryClient, pr: PullRequest): GitHubUser | null {
    if (pr.viewerDidAuthor && pr.author) return pr.author;
    for (const [, data] of client.getQueriesData({ queryKey: keyRoots.repoPullRequests })) {
        if (isRepoPullRequests(data) && data.viewer && data.pullRequests.some(item => item.url === pr.url)) {
            return { login: data.viewer };
        }
    }
    return null;
}
