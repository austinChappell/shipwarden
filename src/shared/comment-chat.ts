import { fence, lineLabel, MAX_PATCH } from './ask-agent';
import type { DiffSide, PendingComment, RepoRef, ReviewThread } from './github';

/** A message in a chat about a review comment. */
export interface CommentChatMessage {
    id: string;
    role: 'user' | 'agent';
    /** The text of the message. An agent message is Markdown. */
    text: string;
    /** The name of the agent that wrote an agent message. */
    agent?: string;
    /** The time of the message, in milliseconds since 1970. */
    at: number;
}

/** The comment of a chat: a review thread, or a pending comment of the user. */
export type CommentChatSubject = { kind: 'thread'; thread: ReviewThread } | { kind: 'pending'; comment: PendingComment };

/** The lines of a chat subject. A thread that is outdated gives its lines in the commit of the comment. */
export function subjectLines(subject: CommentChatSubject): { path: string; side: DiffSide; startLine: number; line: number; outdated: boolean } | undefined {
    if (subject.kind === 'pending') {
        const { path, side, line, startLine } = subject.comment;
        return { path, side, startLine: startLine ?? line, line, outdated: false };
    }
    const thread = subject.thread;
    const outdated = thread.line === null;
    const line = thread.line ?? thread.originalLine;
    if (line === null) return undefined;
    const startLine = (outdated ? thread.originalStartLine : thread.startLine) ?? line;
    return { path: thread.path, side: thread.side, startLine: Math.min(startLine, line), line, outdated };
}

/**
 * Returns the key of a chat in the chat store.
 * A thread uses its ID. A pending comment has no ID, so its key uses its place. An edit of its text keeps the chat.
 */
export function commentChatKey(scope: string, number: number, subject: CommentChatSubject): string {
    if (subject.kind === 'thread') return `${scope}#${number}:thread:${subject.thread.id}`;
    const { path, side, line, startLine } = subject.comment;
    return `${scope}#${number}:pending:${side}:${startLine ?? line}-${line}:${path}`;
}

export interface CommentChatPromptInput {
    pr: { number: number; title: string; url: string; baseRefName: string; headRefName: string; headRefOid: string };
    /** The repository. Undefined when the agent runs in the worktree of the pull request. */
    repo?: RepoRef;
    subject: CommentChatSubject;
    /** The text of the lines of the comment in the head commit, or undefined when it is not available. */
    code?: string;
    /** The "@@" hunks of the file, or undefined when they are not available. */
    patch?: string;
    /** The messages of the chat before the new message, oldest first. */
    history: readonly CommentChatMessage[];
    message: string;
}

/** Returns the text of the comment, with the author of each comment of a thread. */
function subjectText(subject: CommentChatSubject): string {
    if (subject.kind === 'pending') return subject.comment.body.trim();
    return subject.thread.comments.map(comment => `${comment.author?.login ?? 'someone'}: ${comment.body.trim()}`).join('\n\n');
}

/**
 * Returns the prompt for one message of a chat about a review comment.
 * The agent runs in print mode and keeps no memory, so the prompt has all earlier messages of the chat.
 */
export function commentChatPrompt(input: CommentChatPromptInput): string {
    const { pr, repo, subject } = input;
    const lines = subjectLines(subject);
    const repoName = repo ? ` in ${repo.owner}/${repo.name}` : '';
    const parts = [
        `I review pull request #${pr.number} "${pr.title}"${repoName}: ${pr.url}`,
        `It merges ${pr.headRefName} (${pr.headRefOid}) into ${pr.baseRefName}.`
    ];
    const place = lines
        ? `${lines.path}, ${lineLabel(lines.startLine, lines.line)} of ${lines.side === 'LEFT' ? 'the old version (the removed lines)' : 'the new version'}${lines.outdated ? ' in an older commit' : ''}`
        : 'a file of the pull request';
    const comment =
        subject.kind === 'pending'
            ? `I wrote this review comment on ${place}. I did not post it yet.`
            : `A review thread on ${place}${subject.thread.isResolved ? ' (resolved)' : ''} has these comments.`;
    const text = subjectText(subject);
    const textFence = fence(text);
    parts.push(`${comment}\n\n${textFence}\n${text}\n${textFence}`);
    if (input.code !== undefined) {
        const marker = fence(input.code);
        parts.push(`The lines of the comment:\n\n${marker}\n${input.code}\n${marker}`);
    }
    if (input.patch) {
        const patch = input.patch.length > MAX_PATCH ? `${input.patch.slice(0, MAX_PATCH)}\n… (the diff continues)` : input.patch;
        const marker = fence(patch);
        parts.push(`The diff of the file in the pull request:\n\n${marker}diff\n${patch}\n${marker}`);
    }
    parts.push(
        'I want to talk about this comment with you. Do not make the change, and do not change files. Read more of the code if it helps you. Write the answer in Markdown.'
    );
    if (input.history.length) {
        const history = input.history.map(message => `${message.role === 'user' ? 'Me' : 'You'}: ${message.text.trim()}`).join('\n\n');
        const marker = fence(history);
        parts.push(`Our chat until now:\n\n${marker}\n${history}\n${marker}`);
    }
    parts.push(`My new message: ${input.message.trim()}`);
    return parts.join('\n\n');
}
