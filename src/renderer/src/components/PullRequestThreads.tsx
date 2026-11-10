import { useState } from 'react';
import { Bot } from 'lucide-react';
import type { PullRequest, RepoTarget, ReviewThread } from '@shared/github';
import { threadLine, threadPrompt } from '../github/agent-prompts';
import { visibleThreads, type ConversationItem } from '../github/review-state';
import { timeAgo } from '../util';
import { Markdown } from './Markdown';
import { CommentBody } from './CommentBody';
import { threadSuggestionTarget } from '@shared/suggestion';
import { applyThreadSuggestion } from '../github/suggestions';
import { replyToThread, setThreadResolved } from '../github/pull-request-mutations';
import { REVIEW_STATE_TEXT } from './PullRequestTimeline';
import { Reactions, reactionActions, type ReactionActions } from './Reactions';

interface Props {
    target: RepoTarget;
    pr: PullRequest;
    /** True when the list shows the resolved threads too. */
    showResolved: boolean;
    onShowResolved(value: boolean): void;
    busy: boolean;
    /** Runs a change on the host. The panel shows the busy state and the error of the change. */
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
    const reactions = reactionActions(target, pr);

    const sendReply = (thread: ReviewThread) => {
        if (thread.comments.length === 0 || !replyText.trim()) {
            return;
        }
        run(async () => {
            await replyToThread(target, pr, thread, replyText.trim());
            setReplyText('');
            setReplyTo(undefined);
        });
    };

    return (
        <section className="pr-section">
            <div className="section-title">
                <span>
                    Review threads <span className="section-title-count">· {unresolved} unresolved</span>
                </span>
                {pr.threads.length > unresolved && (
                    <button className="link-button" onClick={() => onShowResolved(!showResolved)}>
                        {showResolved ? 'Hide resolved' : 'Show resolved'}
                    </button>
                )}
            </div>
            {threads.length === 0 && <div className="panel-note pr-threads-empty">No review comments yet.</div>}
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
                            <CommentBody
                                body={comment.body}
                                original={threadSuggestionTarget(thread)?.original}
                                outdated={thread.isOutdated}
                                onApply={
                                    typeof target === 'string' && threadSuggestionTarget(thread)
                                        ? lines => applyThreadSuggestion(target, thread, lines)
                                        : undefined
                                }
                            />
                            <Reactions subjectId={comment.id} reactions={comment.reactions} actions={reactions} />
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
                        <button className="link-button" disabled={busy} onClick={() => run(() => setThreadResolved(target, pr, thread, !thread.isResolved))}>
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
export function PullRequestConversation({ items, reactions }: { items: ConversationItem[]; reactions?: ReactionActions }) {
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
                    {item.body.trim() && <Reactions subjectId={item.id} reactions={item.reactions} actions={reactions} />}
                </div>
            ))}
        </section>
    );
}
