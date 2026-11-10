import type {
    GitHubLabel,
    MergeMethod,
    NewPullRequest,
    PendingComment,
    PullRequest,
    PullRequestChange,
    RepoRef,
    RepoTarget,
    ReviewEvent,
    ReviewThread
} from '@shared/github';
import { keyRoots, queryClient } from '../query-client';
import { applyMerged } from './review-overview-store';
import {
    changedPullRequest,
    invalidatePullRequest,
    mergedPullRequest,
    reviewedPullRequest,
    reviewStateOf,
    viewerOf,
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

/**
 * Submits a review with the pending comments. The comments become new threads on the host. Their IDs are not known
 * here, and a reply needs them. Thus a review with comments loads the pull request again.
 */
export async function submitReview(target: RepoTarget, pr: PullRequest, event: ReviewEvent, body: string, comments: PendingComment[]): Promise<void> {
    await api().submitReview(target, pr.number, pr.headRefOid, event, body, comments);
    const submittedAt = new Date().toISOString();
    writePullRequest(queryClient, pr, current => reviewedPullRequest(current, { id: localId('review'), event, body, viewer: viewer(current), submittedAt }), {
        state: reviewStateOf(event),
        submittedAt
    });
    if (comments.length > 0) {
        await invalidatePullRequest(queryClient, pr.url);
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
