import { useSyncExternalStore } from 'react';
import { sliceLines } from '@shared/ask-agent';
import { commentChatKey, commentChatPrompt, subjectLines, type CommentChatMessage, type CommentChatSubject } from '@shared/comment-chat';
import { targetKey, type PullRequest, type PullRequestFile, type RepoTarget } from '@shared/github';
import { errorText } from '../util';
import { reviewStore } from './review-store';

/** A chat with the agent about one review comment. */
export interface CommentChat {
    messages: CommentChatMessage[];
    /** The ID of the agent run while the agent writes an answer. */
    running?: string;
    error?: string;
    /** True when the chat shows under the comment. */
    open: boolean;
    /** The text in the chat box. It stays when the diff makes the zone again. */
    draft: string;
}

/** The data that a chat message needs. */
export interface CommentChatContext {
    target: RepoTarget;
    pr: PullRequest;
    subject: CommentChatSubject;
    /** The file of the comment. With it, the prompt has the diff and the lines of the comment. */
    file?: PullRequestFile;
}

const EMPTY: CommentChat = { messages: [], open: false, draft: '' };

/**
 * The chats of this app session, by key. A chat stays when its comment zone closes, because the diff makes the zones
 * again on each change. The chats do not go to disk.
 */
const chats = new Map<string, CommentChat>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function change(key: string, update: (chat: CommentChat) => CommentChat): void {
    chats.set(key, update(chats.get(key) ?? EMPTY));
    for (const listener of listeners) listener();
}

/** Returns the key of the chat of a comment. */
export function chatKeyOf(context: CommentChatContext): string {
    return commentChatKey(targetKey(context.target), context.pr.number, context.subject);
}

/** Returns the chat of a key. The component renders again when the chat changes. */
export function useCommentChat(key: string): CommentChat {
    return useSyncExternalStore(subscribe, () => chats.get(key) ?? EMPTY);
}

/** Shows or hides the chat under its comment. */
export function setChatOpen(key: string, open: boolean): void {
    change(key, chat => ({ ...chat, open }));
}

/** Keeps the text of the chat box. */
export function setChatDraft(key: string, draft: string): void {
    change(key, chat => ({ ...chat, draft }));
}

/** Stops the agent run of the chat. The message of the user stays. */
export function cancelChatRun(key: string): void {
    const run = chats.get(key)?.running;
    if (!run) return;
    void window.shipwarden.ask.cancel(run);
    change(key, chat => ({ ...chat, running: undefined }));
}

/** Removes all messages of the chat and stops its agent run. */
export function clearChat(key: string): void {
    cancelChatRun(key);
    change(key, chat => ({ ...chat, messages: [], error: undefined }));
}

/** Returns the text of the lines of the comment in the head commit, or undefined when it is not available. */
async function commentCode(context: CommentChatContext): Promise<string | undefined> {
    const lines = subjectLines(context.subject);
    // The lines of an outdated thread are in an older commit. The head commit does not have them.
    if (!context.file || !lines || lines.outdated) return undefined;
    try {
        const versions = await reviewStore.fileVersions(context.target, context.file, context.pr.baseRefOid, context.pr.headRefOid);
        if (versions.unavailable) return undefined;
        return sliceLines(lines.side === 'LEFT' ? versions.base : versions.head, lines.startLine, lines.line);
    } catch {
        // The prompt has the diff. The agent can read the file itself.
        return undefined;
    }
}

/**
 * Sends a message of the user to the agent, and adds the answer to the chat. The agent runs in print mode, so it
 * does not change files. A message while the agent writes does nothing.
 */
export async function sendChatMessage(context: CommentChatContext, text: string): Promise<void> {
    const key = chatKeyOf(context);
    const message = text.trim();
    const before = chats.get(key) ?? EMPTY;
    if (!message || before.running) return;
    const run = crypto.randomUUID();
    const history = before.messages;
    change(key, chat => ({
        ...chat,
        open: true,
        draft: '',
        error: undefined,
        running: run,
        messages: [...chat.messages, { id: crypto.randomUUID(), role: 'user', text: message, at: Date.now() }]
    }));
    try {
        const { target, pr } = context;
        const repo = typeof target === 'string' ? undefined : target;
        const prompt = commentChatPrompt({
            pr,
            repo,
            subject: context.subject,
            code: await commentCode(context),
            patch: context.file?.patch,
            history,
            message
        });
        const result = repo
            ? await window.shipwarden.ask.run({ id: run, repo, headRefOid: pr.headRefOid, prompt })
            : await window.shipwarden.ask.run({
                  id: run,
                  worktree: target as string,
                  prompt: `The current folder is the git worktree of the pull request branch.\n\n${prompt}`
              });
        // A cancelled or cleared run does not add its answer.
        if (chats.get(key)?.running !== run) return;
        change(key, chat => ({
            ...chat,
            running: undefined,
            messages: [...chat.messages, { id: run, role: 'agent', text: result.answer, agent: result.agent, at: Date.now() }]
        }));
    } catch (err) {
        if (chats.get(key)?.running !== run) return;
        change(key, chat => ({ ...chat, running: undefined, error: errorText(err) }));
    }
}

/** Sends the last message of the user again, after an error. */
export function retryChat(context: CommentChatContext): void {
    const key = chatKeyOf(context);
    const chat = chats.get(key);
    const last = chat?.messages.at(-1);
    if (!chat || chat.running || last?.role !== 'user') return;
    change(key, current => ({ ...current, messages: current.messages.slice(0, -1) }));
    void sendChatMessage(context, last.text);
}
