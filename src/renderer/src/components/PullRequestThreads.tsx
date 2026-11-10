import { useState } from 'react';
import { Bot } from 'lucide-react';
import type { PullRequest, RepoTarget, ReviewThread } from '@shared/github';
import { threadLine, threadPrompt } from '../github/agent-prompts';
import { visibleThreads, type ConversationItem } from '../github/review-state';
import { timeAgo } from '../util';
import { Markdown } from './Markdown';
import { REVIEW_STATE_TEXT } from './PullRequestTimeline';

interface Props {
    target: RepoTarget;
    pr: PullRequest;
    /** True when the list shows the resolved threads too. */
    showResolved: boolean;
    onShowResolved(value: boolean): void;
    busy: boolean;
    /** Runs a change on the host. Then the panel loads the pull request again. */
    run(action: () => Promise<void>): Promise<void>;
    /** Opens the diff of the file of a thread at the line of the thread. */
    onOpen(thread: ReviewThread): void;
    /** Sends a review comment to the agent of the worktree. Without it, the button does not show. */
    onSendToAgent?(prompt: string): void;
}

/** The review threads of a pull request, with buttons that reply, resolve, and send a thread to the agent. */
export function PullRequestThreads({ target, pr, showResolved, onShowResolved, busy, run, onOpen, onSendToAgent }: Props) {
    const [replyTo, setReplyTo] = useState<string>();
    const [replyText, setReplyText] = useState('');
    const threads = visibleThreads(pr.threads, showResolved);
    const unresolved = pr.threads.filter(thread => !thread.isResolved).length;

    const sendReply = (thread: ReviewThread) => {
        const last = thread.comments[thread.comments.length - 1];
        if (!last || !replyText.trim()) {
            return;
        }
        run(async () => {
            await window.shipwarden.github.reply(target, pr.number, last.databaseId, replyText.trim());
            setReplyText('');
            setReplyTo(undefined);
        });
    };

    return (
        <section className="pr-section">
            <div className="section-title">
                Review threads ({unresolved} unresolved)
                {pr.threads.length > unresolved && (
                    <button className="link-button" onClick={() => onShowResolved(!showResolved)}>
                        {showResolved ? 'Hide resolved' : 'Show resolved'}
                    </button>
                )}
            </div>
            {threads.length === 0 && <div className="panel-note">No review comments.</div>}
            {threads.map(thread => (
                <div key={thread.id} className={`thread-card${thread.isResolved ? ' resolved' : ''}`}>
                    <button className="thread-location" onClick={() => onOpen(thread)}>
                        {thread.path}
                        {threadLine(thread) ? `:${threadLine(thread)}` : ''}
                        {thread.isOutdated && <span className="tag">outdated</span>}
                        {thread.isResolved && <span className="tag">resolved</span>}
                    </button>
                    {thread.comments.map(comment => (
                        <div key={comment.id} className="thread-comment">
                            <div className="comment-author">
                                {comment.author?.login ?? 'unknown'} <span>{timeAgo(comment.createdAt)}</span>
                            </div>
                            <Markdown className="comment-body" text={comment.body} />
                        </div>
                    ))}
                    {replyTo === thread.id && (
                        <div className="reply-box">
                            <textarea autoFocus value={replyText} placeholder="Reply" onChange={event => setReplyText(event.target.value)} />
                            <div className="row-buttons">
                                <button className="button" onClick={() => setReplyTo(undefined)}>
                                    Cancel
                                </button>
                                <button className="button primary" disabled={busy || !replyText.trim()} onClick={() => sendReply(thread)}>
                                    Reply
                                </button>
                            </div>
                        </div>
                    )}
                    <div className="thread-actions">
                        <button
                            className="link-button"
                            onClick={() => {
                                setReplyTo(thread.id);
                                setReplyText('');
                            }}
                        >
                            Reply
                        </button>
                        <button
                            className="link-button"
                            disabled={busy}
                            onClick={() => run(() => window.shipwarden.github.setThreadResolved(target, thread.id, !thread.isResolved))}
                        >
                            {thread.isResolved ? 'Unresolve' : 'Resolve'}
                        </button>
                        {onSendToAgent && (
                            <button className="link-button" onClick={() => onSendToAgent(threadPrompt(pr, thread))}>
                                <Bot size={13} strokeWidth={1.6} /> Send to agent
                            </button>
                        )}
                    </div>
                </div>
            ))}
        </section>
    );
}

/** The comments and reviews of the conversation of a pull request. */
export function PullRequestConversation({ items }: { items: ConversationItem[] }) {
    return (
        <section className="pr-section">
            <div className="section-title">Conversation ({items.length})</div>
            {items.map(item => (
                <div key={item.id} className="thread-card">
                    <div className="comment-author">
                        {item.author ?? 'unknown'}
                        {item.state && (
                            <span className={`tag review-${item.state.toLowerCase()}`}>{REVIEW_STATE_TEXT[item.state] ?? item.state.toLowerCase()}</span>
                        )}
                        <span>{timeAgo(item.createdAt)}</span>
                    </div>
                    {item.body.trim() && <Markdown className="comment-body" text={item.body} />}
                </div>
            ))}
        </section>
    );
}
