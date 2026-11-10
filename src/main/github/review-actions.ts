import type { MergeMethod, PendingComment, PullRequestChange, RepoRef, ReviewEvent } from '@shared/github';
import type { GitHubClient } from './github-client';

/** Makes one change to a pull request: the details, an assignee, a reviewer or a label. */
export async function changePullRequest(client: GitHubClient, repo: RepoRef, number: number, change: PullRequestChange): Promise<void> {
    const base = `/repos/${repo.owner}/${repo.name}`;
    switch (change.kind) {
        case 'details':
            await client.rest('PATCH', `${base}/pulls/${number}`, { title: change.title, body: change.body, state: change.state });
            return;
        case 'draft': {
            // Only GraphQL can change the draft state.
            const mutation = change.draft
                ? 'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { id } } }'
                : 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { id } } }';
            await client.graphql(mutation, { id: change.pullRequestId });
            return;
        }
        case 'autoMerge':
            if (change.method) {
                await client.graphql(
                    'mutation($id: ID!, $method: PullRequestMergeMethod!, $head: GitObjectID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $head }) { pullRequest { id } } }',
                    { id: change.pullRequestId, method: change.method.toUpperCase(), head: change.headSha }
                );
            } else {
                await client.graphql('mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { id } } }', {
                    id: change.pullRequestId
                });
            }
            return;
        case 'assignee':
            await client.rest(change.add ? 'POST' : 'DELETE', `${base}/issues/${number}/assignees`, { assignees: [change.login] });
            return;
        case 'reviewer': {
            const field = change.reviewer.kind === 'team' ? 'team_reviewers' : 'reviewers';
            await client.rest(change.add ? 'POST' : 'DELETE', `${base}/pulls/${number}/requested_reviewers`, { [field]: [change.reviewer.login] });
            return;
        }
        case 'label':
            if (change.add) {
                await client.rest('POST', `${base}/issues/${number}/labels`, { labels: [change.name] });
            } else {
                await client.rest('DELETE', `${base}/issues/${number}/labels/${encodeURIComponent(change.name)}`);
            }
            return;
    }
}

/** Returns the body of a review request. An empty text is not in the body. */
export function reviewBody(headSha: string, event: ReviewEvent, body: string, comments: PendingComment[]) {
    return {
        commit_id: headSha,
        event,
        body: body || undefined,
        comments: comments.map(comment => ({ path: comment.path, line: comment.line, side: comment.side, body: comment.body }))
    };
}

/** Sends a review with its pending line comments in one request. */
export async function submitReview(
    client: GitHubClient,
    repo: RepoRef,
    number: number,
    headSha: string,
    event: ReviewEvent,
    body: string,
    comments: PendingComment[]
): Promise<void> {
    await client.rest('POST', `/repos/${repo.owner}/${repo.name}/pulls/${number}/reviews`, reviewBody(headSha, event, body, comments));
}

/** Adds a reply to a review comment. */
export async function replyToComment(client: GitHubClient, repo: RepoRef, number: number, commentId: number, body: string): Promise<void> {
    await client.rest('POST', `/repos/${repo.owner}/${repo.name}/pulls/${number}/comments/${commentId}/replies`, { body });
}

/** Marks a review thread as resolved or not resolved. */
export async function setThreadResolved(client: GitHubClient, threadId: string, resolved: boolean): Promise<void> {
    const mutation = resolved
        ? 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }'
        : 'mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id } } }';
    await client.graphql(mutation, { id: threadId });
}

/** Marks a file of a pull request as viewed or not viewed, as the "Viewed" box on GitHub does. `pullRequestId` is the node ID. */
export async function setFileViewed(client: GitHubClient, pullRequestId: string, path: string, viewed: boolean): Promise<void> {
    const mutation = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
    await client.graphql(`mutation($id: ID!, $path: String!) { ${mutation}(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`, {
        id: pullRequestId,
        path
    });
}

/** Merges a pull request. GitHub refuses the merge when the head is not `headSha`. */
export async function merge(client: GitHubClient, repo: RepoRef, number: number, headSha: string, method: MergeMethod): Promise<void> {
    await client.rest('PUT', `/repos/${repo.owner}/${repo.name}/pulls/${number}/merge`, { merge_method: method, sha: headSha });
}
