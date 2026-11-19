import { lineLabel } from '@shared/ask-agent';
import type { PendingComment, PullRequest, Review, ReviewThread } from '@shared/github';

/** Returns the line of a thread in the current diff, or its line in an older commit. Null when it has no line. */
export function threadLine(thread: ReviewThread): number | null {
    return thread.line ?? thread.originalLine;
}

/** Returns the place of a thread, for example "src/a.ts line 12". */
export function threadPlace(thread: ReviewThread): string {
    const line = threadLine(thread);
    return `${thread.path}${line ? ` line ${line}` : ''}`;
}

/** Returns the comments of a thread, each with its author, separated by empty lines. */
export function threadComments(thread: ReviewThread): string {
    return thread.comments.map(comment => `${comment.author?.login ?? 'someone'}: ${comment.body}`).join('\n\n');
}

/** Makes the agent prompt for a review thread. */
export function threadPrompt(pr: PullRequest, thread: ReviewThread): string {
    return `A reviewer left this comment on ${threadPlace(thread)} in pull request #${pr.number} (${pr.url}):\n\n${threadComments(thread)}\n\nMake the change that the reviewer asks for.`;
}

/** The lines and the text of a pending comment, or of a note from the comment box. */
export type LineNote = Pick<PendingComment, 'path' | 'line' | 'startLine' | 'side' | 'body'>;

/**
 * Makes the agent prompt for a note on lines of a pull request: a pending comment, or a note from the comment box.
 * A note on the left side is about removed lines of the old version.
 */
export function lineNotePrompt(pr: PullRequest, note: LineNote): string {
    const lines = lineLabel(note.startLine ?? note.line, note.line);
    const place = note.side === 'LEFT' ? `${note.path} ${lines} of the old version (the removed lines)` : `${note.path} ${lines}`;
    return `I left this note on ${place} in pull request #${pr.number} (${pr.url}):\n\n${note.body.trim()}\n\nMake the change that the note asks for.`;
}

/** Makes the agent prompt for the merge conflicts of a pull request. */
export function conflictPrompt(pr: PullRequest): string {
    return `Pull request #${pr.number} (${pr.url}) has merge conflicts with ${pr.baseRefName}. Fetch origin, merge origin/${pr.baseRefName} into ${pr.headRefName}, resolve the conflicts, run the tests, and commit the merge.`;
}

/**
 * Makes the agent prompt that rebases the head branch of a pull request onto its base branch and pushes the result.
 * The push replaces the remote branch, so it uses "--force-with-lease". The push stops if someone else pushed in the meantime.
 */
export function rebasePrompt(pr: PullRequest): string {
    const base = pr.baseRefName;
    const head = pr.headRefName;
    return [
        `Rebase pull request #${pr.number} (${pr.url}) onto ${base}. Do these steps in this order:`,
        '',
        '1. Run "git fetch origin".',
        `2. Make sure that the worktree is on the branch ${head} and has no uncommitted changes. If it has uncommitted changes, stop and tell me.`,
        `3. Make sure that ${head} has all commits of origin/${head}. If it does not, run "git merge --ff-only origin/${head}".`,
        `4. Run "git rebase origin/${base}".`,
        `5. If a conflict occurs, resolve it. Keep the intent of the commits on ${head}. Then run "git add" and "git rebase --continue". Do this for each conflict.`,
        '6. Run the build, the type check, and the tests of the project. Fix each failure that the rebase caused, and commit the fixes.',
        `7. Run "git push --force-with-lease origin ${head}".`,
        '',
        `Do not merge ${base} into ${head}. Do not push if the rebase or the tests fail. If the push fails, do not use "--force". Tell me what stopped you.`
    ].join('\n');
}

/** Makes the agent prompt for a comment or a review on the conversation of a pull request. */
export function commentPrompt(pr: PullRequest, author: string | null, body: string): string {
    return `${author ?? 'Someone'} left this comment on pull request #${pr.number} (${pr.url}):\n\n${body.trim()}\n\nRead the comment and make the changes that it asks for.`;
}

/** Returns the open threads that have one or more comments of the review. */
export function reviewThreads(pr: PullRequest, review: Review): ReviewThread[] {
    return pr.threads.filter(thread => !thread.isResolved && thread.comments.some(comment => comment.reviewId === review.id));
}

/**
 * Makes the agent prompt for a review: its text, and the open threads that have its comments.
 * Each thread has all its comments, so that the agent sees the replies too.
 */
export function reviewPrompt(pr: PullRequest, review: Review): string {
    const author = review.author?.login ?? 'Someone';
    const parts = [`${author} reviewed pull request #${pr.number} (${pr.url}).`];
    if (review.body.trim()) {
        parts.push(`The text of the review:\n\n${review.body.trim()}`);
    }
    for (const thread of reviewThreads(pr, review)) {
        parts.push(`The thread on ${threadPlace(thread)}:\n\n${threadComments(thread)}`);
    }
    parts.push('Make the changes that the review asks for.');
    return parts.join('\n\n');
}
