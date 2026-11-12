import { useState } from 'react';
import { Bot } from 'lucide-react';
import type { PullRequest, RepoTarget, ReviewThread } from '@shared/github';
import { commentPrompt, reviewPrompt, reviewThreads, threadLine, threadPrompt } from '../github/agent-prompts';
import { visibleThreads, type ConversationItem } from '../github/review-state';
import { timeAgo } from '../util';
import { Markdown } from './Markdown';
import { CommentBody } from './CommentBody';
import { threadSuggestionTarget } from '@shared/suggestion';
import { applyThreadSuggestion } from '../github/suggestions';
import { replyToThread, setThreadResolved } from '../github/pull-request-mutations';
import { REVIEW_STATE_TEXT } from './PullRequestTimeline';
import { Reactions, reactionActions, type ReactionActions } from './Reactions';
import { MentionTextarea } from './MentionTextarea';
import { Button } from './ui';

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
                    <Button variant="link" onClick={() => onShowResolved(!showResolved)}>
                        {showResolved ? 'Hide resolved' : 'Show resolved'}
                    </Button>
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
                            <MentionTextarea
                                autoFocus
                                className="input textarea reply-text"
                                value={replyText}
                                placeholder="Reply"
                                onValueChange={setReplyText}
                            />
                            <div className="row-buttons">
                                <Button onClick={() => setReplyTo(undefined)}>Cancel</Button>
                                <Button variant="primary" disabled={busy || !replyText.trim()} onClick={() => sendReply(thread)}>
                                    Reply
                                </Button>
                            </div>
                        </div>
                    )}
                    <div className="thread-actions">
                        <Button
                            variant="link"
                            onClick={() => {
                                setReplyTo(thread.id);
                                setReplyText('');
                            }}
                        >
                            Reply
                        </Button>
                        <Button variant="link" disabled={busy} onClick={() => run(() => setThreadResolved(target, pr, thread, !thread.isResolved))}>
                            {thread.isResolved ? 'Unresolve' : 'Resolve'}
                        </Button>
                        {onSendToAgent && (
                            <Button variant="link" icon={<Bot size={13} strokeWidth={1.6} />} onClick={() => onSendToAgent(threadPrompt(pr, thread))}>
                                Send to agent
                            </Button>
                        )}
                    </div>
                </div>
            ))}
        </section>
    );
}

/** The comments and reviews of the conversation of a pull request. */
/** With `onSendToAgent`, each item has a button that sends it to the agent. A review prompt also has its open threads. */
export function PullRequestConversation({
    pr,
    items,
    reactions,
    onSendToAgent
}: {
    pr: PullRequest;
    items: ConversationItem[];
    reactions?: ReactionActions;
    onSendToAgent?(prompt: string): void;
}) {
    return (
        <section className="pr-section">
            <div className="section-title">Conversation ({items.length})</div>
            {items.map(item => {
                const review = pr.reviews.find(candidate => candidate.id === item.id);
                return (
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
                        {onSendToAgent && (item.body.trim() || (review && reviewThreads(pr, review).length > 0)) && (
                            <div className="thread-actions">
                                <Button
                                    variant="link"
                                    icon={<Bot size={13} strokeWidth={1.6} />}
                                    onClick={() => onSendToAgent(review ? reviewPrompt(pr, review) : commentPrompt(pr, item.author, item.body))}
                                >
                                    Send to agent
                                </Button>
                            </div>
                        )}
                    </div>
                );
            })}
        </section>
    );
}
