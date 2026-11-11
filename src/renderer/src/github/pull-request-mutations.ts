import type {
    GitHubLabel,
    MergeMethod,
    NewPullRequest,
    PendingComment,
    PullRequest,
    PullRequestChange,
    ReactionContent,
    RepoRef,
    RepoTarget,
    ReviewEvent,
    ReviewThread
} from '@shared/github';
import { keyRoots, queryClient } from '../query-client';
import { applyMerged } from './review-overview-store';
import {
    changedPullRequest,
    cachedPullRequest,
    changesMergeState,
    invalidatePullRequest,
    mergeStateMayBeOld,
    mergedPullRequest,
    reviewedPullRequest,
    reviewStateOf,
    viewerOf,
    withReaction,
    withReply,
    withThreadResolved,
    writePullRequest
} from './pull-request-cache';

/*
 * The changes to a pull request on GitHub or Azure DevOps. Each function sends the change to the host and then
 * puts the known result into the cache. The views then show the change without a new request.
 */

const api = () => window.shipwarden.github;

/** The ID of a comment or a review that exists only in the cache. The next load replaces it with the real item. */
let nextLocalId = 0;
function localId(kind: string): string {
    return `local-${kind}-${Date.now()}-${nextLocalId++}`;
}

/** The author of a local comment or review. Without a known login, the author shows as "you". */
function viewer(pr: PullRequest) {
    return viewerOf(queryClient, pr) ?? { login: 'you' };
}

/**
 * Merges a pull request. `repo` is the repository of the pull request. With it, the Review view and the Dashboard
 * also update their lists, and the merged list of the repository loads again.
 */
export async function mergePullRequest(target: RepoTarget, pr: PullRequest, method: MergeMethod, repo: RepoRef | undefined): Promise<void> {
    await api().merge(target, pr.number, pr.headRefOid, method);
    if (repo) applyMerged([{ repo, number: pr.number }]);
    // This patch also covers the branch status and the branch summaries. A second patch of a merged item changes nothing.
    writePullRequest(queryClient, pr, mergedPullRequest);
}

/** Changes the details, the draft state, the auto-merge, an assignee, a reviewer or a label of a pull request. */
export async function changePullRequest(target: RepoTarget, pr: PullRequest, change: PullRequestChange, knownLabels?: GitHubLabel[]): Promise<void> {
    await api().changePullRequest(target, pr.number, change);
    writePullRequest(queryClient, pr, current => changedPullRequest(current, change, knownLabels, viewerOf(queryClient, current)));
}

/** The time between the review and the second load, when the merge state of the first load can be old. */
export const MERGE_STATE_RELOAD_MS = 3_000;

/**
 * Submits a review with the pending comments. The pull request loads again in two cases:
 * - The review has comments. The comments become new threads on the host. A reply needs their IDs, and the IDs are not known here.
 * - The review approves or blocks. The host calculates the new merge state, and the merge button needs it.
 *   When the merge state of that load can be old, the pull request loads one more time after MERGE_STATE_RELOAD_MS.
 */
export async function submitReview(target: RepoTarget, pr: PullRequest, event: ReviewEvent, body: string, comments: PendingComment[]): Promise<void> {
    await api().submitReview(target, pr.number, pr.headRefOid, event, body, comments);
    const submittedAt = new Date().toISOString();
    writePullRequest(queryClient, pr, current => reviewedPullRequest(current, { id: localId('review'), event, body, viewer: viewer(current), submittedAt }), {
        state: reviewStateOf(event),
        submittedAt
    });
    if (comments.length > 0 || changesMergeState(event)) {
        await invalidatePullRequest(queryClient, pr.url);
    }
    if (changesMergeState(event)) {
        const loaded = cachedPullRequest(queryClient, pr.url);
        if (loaded && mergeStateMayBeOld(loaded)) {
            setTimeout(() => void invalidatePullRequest(queryClient, pr.url), MERGE_STATE_RELOAD_MS);
        }
    }
}

/** Adds a reply at the end of a review thread. */
export async function replyToThread(target: RepoTarget, pr: PullRequest, thread: ReviewThread, body: string): Promise<void> {
    const last = thread.comments[thread.comments.length - 1];
    await api().reply(target, pr.number, last.databaseId, body);
    writePullRequest(queryClient, pr, current =>
        withReply(current, thread.id, {
            id: localId('comment'),
            // The host puts a reply to any comment of a thread at the end of the thread. A next reply to this ID is correct.
            databaseId: last.databaseId,
            author: viewer(current),
            body,
            createdAt: new Date().toISOString(),
            url: last.url
        })
    );
}

/**
 * Adds (`on`) or removes a reaction of the user to a comment or a review. `subjectId` is the `id` of the item.
 * The cache gets the new count, so the pull request does not load again.
 */
export async function setReaction(target: RepoTarget, pr: PullRequest, subjectId: string, content: ReactionContent, on: boolean): Promise<void> {
    await api().setReaction(target, pr.number, subjectId, content, on);
    writePullRequest(queryClient, pr, current => withReaction(current, subjectId, content, on));
}

/** Resolves a review thread, or makes it not resolved. */
export async function setThreadResolved(target: RepoTarget, pr: PullRequest, thread: ReviewThread, resolved: boolean): Promise<void> {
    await api().setThreadResolved(target, thread.id, resolved);
    writePullRequest(queryClient, pr, current => withThreadResolved(current, thread.id, resolved));
}

/**
 * Creates a pull request from the branch of a worktree. The host returns only the number, so the status of the
 * worktree and the branch summaries load again.
 */
export async function createPullRequest(root: string, request: NewPullRequest): Promise<void> {
    await api().createPullRequest(root, request);
    await Promise.all([
        queryClient.invalidateQueries({ queryKey: [...keyRoots.branchStatus, root] }),
        queryClient.invalidateQueries({ queryKey: keyRoots.branchSummaries })
    ]);
}
