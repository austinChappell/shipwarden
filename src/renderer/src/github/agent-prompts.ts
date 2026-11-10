import type { PullRequest, ReviewThread } from '@shared/github';

/** Returns the line of a thread in the current diff, or its line in an older commit. Null when it has no line. */
export function threadLine(thread: ReviewThread): number | null {
    return thread.line ?? thread.originalLine;
}

/** Makes the agent prompt for a review thread. */
export function threadPrompt(pr: PullRequest, thread: ReviewThread): string {
    const comments = thread.comments.map(comment => `${comment.author?.login ?? 'someone'}: ${comment.body}`).join('\n\n');
    const line = threadLine(thread);
    return `A reviewer left this comment on ${thread.path}${line ? ` line ${line}` : ''} in pull request #${pr.number} (${pr.url}):\n\n${comments}\n\nMake the change that the reviewer asks for.`;
}

/** Makes the agent prompt for the merge conflicts of a pull request. */
export function conflictPrompt(pr: PullRequest): string {
    return `Pull request #${pr.number} (${pr.url}) has merge conflicts with ${pr.baseRefName}. Fetch origin, merge origin/${pr.baseRefName} into ${pr.headRefName}, resolve the conflicts, run the tests, and commit the merge.`;
}
