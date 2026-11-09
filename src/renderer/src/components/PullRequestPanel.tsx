import { useEffect, useState } from 'react';
import { Bot, Check, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, MessageSquare, RefreshCw, TriangleAlert } from 'lucide-react';
import { baseName, parentPath } from '@shared/files';
import type { BranchStatus, MergeMethod, PullRequest, PullRequestChange, PullRequestFile, RepoTarget, ReviewEvent, ReviewThread } from '@shared/github';
import { fileIcon } from '../files/file-icons';
import { gitHubSeenKey } from '@shared/dashboard';
import { reviewStore, useReviewState } from '../github/review-store';
import { seenStore } from '../seen-store';
import { errorText, timeAgo } from '../util';
import { Markdown } from './Markdown';
import { confirmDialog } from './ConfirmDialog';
import { DescriptionEditor, EditDescriptionButton, PullRequestMeta } from './PullRequestDetails';
import { openLink } from '../links';

interface Props {
    /** The worktree of the branch, or the repository in the Review view. */
    target: RepoTarget;
    status: BranchStatus | null | undefined;
    loading: boolean;
    error?: string;
    onRefresh(): Promise<void>;
    onOpenDiff(pr: PullRequest, file: PullRequestFile, line?: number): void;
    /** Sends a review comment to the agent of the worktree. Without it (in the Review view), the button does not show. */
    onSendToAgent?(prompt: string): void;
    /**
     * "panel" is the full panel of a worktree. "overview" is the Overview tab of the Review view:
     * no header and no file list (the view shows them), and the description is open.
     */
    variant?: 'panel' | 'overview';
}

const ICON = { size: 15, strokeWidth: 1.6 };
const MERGE_LABELS: Record<MergeMethod, string> = { merge: 'Create a merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' };

export function StateBadge({ pr }: { pr: PullRequest }) {
    if (pr.state === 'MERGED') return <span className="pr-badge merged"><GitMerge {...ICON} />Merged</span>;
    if (pr.state === 'CLOSED') return <span className="pr-badge closed"><GitPullRequestClosed {...ICON} />Closed</span>;
    if (pr.isDraft) return <span className="pr-badge draft"><GitPullRequestDraft {...ICON} />Draft</span>;
    return <span className="pr-badge open"><GitPullRequest {...ICON} />Open</span>;
}

/** True when the pull request is open and GitHub reports conflicts with the base branch. */
export function hasConflicts(pr: PullRequest): boolean {
    return pr.state === 'OPEN' && pr.mergeable === 'CONFLICTING';
}

/** A red badge next to the state badge when the pull request has merge conflicts. */
export function ConflictBadge({ pr }: { pr: PullRequest }) {
    if (!hasConflicts(pr)) return null;
    return (
        <span className="pr-badge conflict" title={`The branch ${pr.headRefName} has conflicts with ${pr.baseRefName}. GitHub cannot merge it.`}>
            <TriangleAlert {...ICON} />Merge conflicts
        </span>
    );
}

export function reviewText(pr: PullRequest): string {
    switch (pr.reviewDecision) {
        case 'APPROVED': return 'Approved';
        case 'CHANGES_REQUESTED': return 'Changes requested';
        case 'REVIEW_REQUIRED': return 'Review required';
        default: return 'No review decision';
    }
}

function mergeBlocker(pr: PullRequest): string | undefined {
    if (pr.state !== 'OPEN') return 'The pull request is not open.';
    if (pr.isDraft) return 'The pull request is a draft.';
    if (pr.mergeable === 'CONFLICTING') return 'The branch has conflicts with the base branch.';
    if (pr.mergeable === 'UNKNOWN') return 'GitHub is still checking whether the branch can merge.';
    if (pr.mergeStateStatus === 'BLOCKED') return 'Branch rules block the merge, for example required reviews or checks.';
    if (pr.mergeStateStatus === 'BEHIND') return 'The branch is behind the base branch.';
    return undefined;
}

/** Makes the agent prompt for a review thread. */
function threadPrompt(pr: PullRequest, thread: ReviewThread): string {
    const comments = thread.comments.map(comment => `${comment.author?.login ?? 'someone'}: ${comment.body}`).join('\n\n');
    const line = thread.line ?? thread.originalLine;
    return `A reviewer left this comment on ${thread.path}${line ? ` line ${line}` : ''} in pull request #${pr.number} (${pr.url}):\n\n${comments}\n\nMake the change that the reviewer asks for.`;
}

interface FileListProps {
    target: RepoTarget;
    pr: PullRequest;
    files: PullRequestFile[] | undefined;
    /** The path of the file that the diff shows, to highlight its row. */
    selectedPath?: string;
    onOpen(file: PullRequestFile): void;
    onError(message: string): void;
}

/** The changed files of a pull request, with the count of open comments and the "Viewed" box of each file. */
export function PullRequestFileList({ target, pr, files, selectedPath, onOpen, onError }: FileListProps) {
    const review = useReviewState(target, pr.number);
    const commentCount = (path: string) =>
        pr.threads.filter(thread => thread.path === path && !thread.isResolved).length + review.pending.filter(comment => comment.path === path).length;
    return (
        <>
            <div className="section-title">
                Files changed {files ? `(${files.length})` : ''}
                {files && files.length > 0 && <span className="viewed-count">{files.filter(item => item.viewed).length} of {files.length} viewed</span>}
            </div>
            {!files && <div className="panel-note">Loading files…</div>}
            {files?.map(file => {
                const Icon = fileIcon(baseName(file.path));
                const count = commentCount(file.path);
                return (
                    <div
                        key={file.path}
                        className={`tree-row pr-file${file.path === selectedPath ? ' selected' : ''}${file.viewed ? ' viewed' : ''}`}
                        title={file.path}
                        onClick={() => onOpen(file)}
                    >
                        <span className={`file-status status-${file.status}`}>{file.status[0].toUpperCase()}</span>
                        <Icon className="tree-icon" size={15} strokeWidth={1.5} />
                        <span className="tree-name">{baseName(file.path)}</span>
                        <span className="tree-detail">{parentPath(file.path)}</span>
                        {count > 0 && <span className="comment-count"><MessageSquare size={12} strokeWidth={1.6} />{count}</span>}
                        <span className="additions">+{file.additions}</span>
                        <span className="deletions">−{file.deletions}</span>
                        <input
                            type="checkbox"
                            className="viewed-box"
                            title={file.viewed ? 'Viewed. Click to mark as not viewed.' : 'Mark as viewed'}
                            checked={!!file.viewed}
                            onClick={event => event.stopPropagation()}
                            onChange={event => reviewStore.setViewed(target, pr.number, pr.id, file.path, event.target.checked).catch(err => onError(errorText(err)))}
                        />
                    </div>
                );
            })}
        </>
    );
}

const REVIEW_STATE_TEXT: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'reviewed', DISMISSED: 'dismissed' };

interface ConversationItem {
    id: string;
    author: string | null;
    body: string;
    createdAt: string;
    state?: string;
}

/** The comments and reviews of the conversation, the oldest first. A review without text or decision is left out. */
function conversationOf(pr: PullRequest): ConversationItem[] {
    return [
        ...pr.issueComments.map(comment => ({ id: comment.id, author: comment.author?.login ?? null, body: comment.body, createdAt: comment.createdAt })),
        ...pr.reviews
            .filter(review => review.body.trim() || review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED')
            .map(review => ({ id: review.id, author: review.author?.login ?? null, body: review.body, createdAt: review.submittedAt ?? '', state: review.state }))
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function PullRequestPanel({ target, status, loading, error, onRefresh, onOpenDiff, onSendToAgent, variant = 'panel' }: Props) {
    const overview = variant === 'overview';
    const pr = status?.pullRequest ?? null;
    const review = useReviewState(target, pr?.number);
    const [body, setBody] = useState('');
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<string>();
    const [mergeMethod, setMergeMethod] = useState<MergeMethod>();
    const [replyTo, setReplyTo] = useState<string>();
    const [replyText, setReplyText] = useState('');
    const [showResolved, setShowResolved] = useState(false);
    const [descriptionOpen, setDescriptionOpen] = useState(false);
    const [editing, setEditing] = useState(false);

    // A different pull request closes the editor.
    useEffect(() => setEditing(false), [pr?.number, pr?.url]);

    useEffect(() => {
        if (pr) {
            reviewStore.loadFiles(target, pr.number).catch(err => setActionError(errorText(err)));
        }
    }, [target, pr?.number, pr?.headRefOid]);

    // The comments that the panel shows count as seen on the Dashboard.
    useEffect(() => {
        if (!pr) return;
        const shownThreads = pr.threads.filter(thread => showResolved || !thread.isResolved);
        const ids = [...pr.issueComments.map(comment => comment.id), ...pr.reviews.map(item => item.id), ...shownThreads.flatMap(thread => thread.comments.map(comment => comment.id))];
        seenStore.mark(ids.map(gitHubSeenKey));
    }, [pr, showResolved]);

    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        setActionError(undefined);
        try {
            await action();
            await onRefresh();
        } catch (err) {
            setActionError(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    if (status === undefined) {
        return <div className="panel-message">{error ?? (loading ? 'Loading the pull request…' : '')}</div>;
    }
    if (status === null) {
        return <div className="panel-message">This worktree has no GitHub remote named "origin".</div>;
    }
    if (!pr) {
        const compareUrl = `https://github.com/${status.repo.owner}/${status.repo.name}/compare/${encodeURIComponent(status.branch)}?expand=1`;
        return (
            <div className="panel-message">
                <p>No pull request for <code>{status.branch}</code>.</p>
                <button className="button" onClick={event => openLink(compareUrl, event)}>
                    Create on GitHub <ExternalLink {...ICON} />
                </button>
            </div>
        );
    }

    const files = review.files;
    const threads = pr.threads.filter(thread => showResolved || !thread.isResolved);
    const conversation = conversationOf(pr);
    const unresolved = pr.threads.filter(thread => !thread.isResolved).length;
    const blocker = mergeBlocker(pr);
    const method = mergeMethod && pr.allowedMergeMethods.includes(mergeMethod)
        ? mergeMethod
        : pr.allowedMergeMethods.includes(pr.defaultMergeMethod) ? pr.defaultMergeMethod : pr.allowedMergeMethods[0];

    const submit = async (event: ReviewEvent) => {
        const labels: Record<ReviewEvent, string> = { APPROVE: 'approve', REQUEST_CHANGES: 'request changes on', COMMENT: 'comment on' };
        const pending = review.pending.length ? ` with ${review.pending.length} inline comment(s)` : '';
        if (!(await confirmDialog({ title: `Submit a review to GitHub: ${labels[event]} pull request #${pr.number}${pending}?`, confirmLabel: 'Submit review' }))) {
            return;
        }
        run(async () => {
            await window.shipwarden.github.submitReview(target, pr.number, pr.headRefOid, event, body.trim(), review.pending);
            reviewStore.clearPending(target, pr.number);
            setBody('');
        });
    };

    const merge = async () => {
        if (method && await confirmDialog({ title: `${MERGE_LABELS[method]}: pull request #${pr.number} into ${pr.baseRefName}?`, confirmLabel: MERGE_LABELS[method] })) {
            run(() => window.shipwarden.github.merge(target, pr.number, pr.headRefOid, method));
        }
    };

    const hasFooter = pr.state === 'OPEN' || (pr.state === 'CLOSED' && pr.viewerCanUpdate);
    const change = (value: PullRequestChange) => run(() => window.shipwarden.github.changePullRequest(target, pr.number, value));

    const setState = async (state: 'open' | 'closed') => {
        const title = state === 'closed' ? `Close pull request #${pr.number} without a merge?` : `Reopen pull request #${pr.number}?`;
        if (await confirmDialog({ title, confirmLabel: state === 'closed' ? 'Close pull request' : 'Reopen' })) {
            change({ kind: 'details', state });
        }
    };

    const setDraft = async (draft: boolean) => {
        const title = draft ? `Convert pull request #${pr.number} to a draft?` : `Mark pull request #${pr.number} as ready for review?`;
        if (await confirmDialog({ title, confirmLabel: draft ? 'Convert to draft' : 'Ready for review' })) {
            change({ kind: 'draft', pullRequestId: pr.id, draft });
        }
    };

    const setAutoMerge = async (on: boolean) => {
        if (on && !method) return;
        const title = on
            ? `Turn on auto-merge for pull request #${pr.number}? GitHub merges it into ${pr.baseRefName} with "${MERGE_LABELS[method!]}" when all the requirements pass.`
            : `Turn off auto-merge for pull request #${pr.number}?`;
        if (await confirmDialog({ title, confirmLabel: on ? 'Enable auto-merge' : 'Disable auto-merge' })) {
            change({ kind: 'autoMerge', pullRequestId: pr.id, method: on ? method! : null, headSha: pr.headRefOid });
        }
    };

    const saveDescription = (title: string, text: string) => run(async () => {
        await window.shipwarden.github.changePullRequest(target, pr.number, {
            kind: 'details',
            title: title === pr.title ? undefined : title,
            body: text === pr.body ? undefined : text
        });
        setEditing(false);
    });

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

    const openThread = (thread: ReviewThread) => {
        const file = files?.find(item => item.path === thread.path);
        if (file) {
            onOpenDiff(pr, file, thread.line ?? thread.originalLine ?? undefined);
        }
    };

    return (
        <div className="pr-panel">
            <div className="pr-scroll">
                {!overview && <div className="pr-header">
                    <div className="pr-title-row">
                        <StateBadge pr={pr} />
                        <ConflictBadge pr={pr} />
                        <button className="link-button" title="Open on GitHub" onClick={event => openLink(pr.url, event)}>
                            #{pr.number} <ExternalLink size={12} strokeWidth={1.6} />
                        </button>
                        <button className="icon-button pr-refresh" title="Refresh" onClick={() => onRefresh()}>
                            <RefreshCw size={14} strokeWidth={1.6} className={loading ? 'spin' : ''} />
                        </button>
                    </div>
                    <h3 className="pr-title">{pr.title}</h3>
                    <div className="pr-meta">
                        {pr.author?.login ?? 'unknown'} {pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'wanted to merge' : 'wants to merge'} into <code>{pr.baseRefName}</code> from <code>{pr.headRefName}</code>
                    </div>
                    <div className="pr-meta">
                        <span className="additions">+{pr.additions}</span> <span className="deletions">−{pr.deletions}</span>
                        <span className="dot-separator">·</span>{reviewText(pr)}
                        <span className="dot-separator">·</span>{timeAgo(pr.createdAt)}
                    </div>
                </div>}

                {hasConflicts(pr) && (
                    <div className="pr-conflict-banner" role="alert">
                        <TriangleAlert size={16} strokeWidth={1.8} />
                        <div className="pr-conflict-text">
                            <strong>This branch has merge conflicts.</strong>
                            <span>Resolve the conflicts with <code>{pr.baseRefName}</code> before you merge.</span>
                        </div>
                        {onSendToAgent && (
                            <button
                                className="button"
                                onClick={() => onSendToAgent(`Pull request #${pr.number} (${pr.url}) has merge conflicts with ${pr.baseRefName}. Fetch origin, merge origin/${pr.baseRefName} into ${pr.headRefName}, resolve the conflicts, run the tests, and commit the merge.`)}
                            >
                                <Bot size={13} strokeWidth={1.6} /> Send to agent
                            </button>
                        )}
                    </div>
                )}

                {editing ? (
                    <section className="pr-section">
                        <div className="section-title">Edit the title and the description</div>
                        {actionError && <div className="form-error pr-section-error">{actionError}</div>}
                        <DescriptionEditor pr={pr} busy={busy} onSave={saveDescription} onCancel={() => setEditing(false)} />
                    </section>
                ) : (pr.body.trim() || overview || pr.viewerCanUpdate) && (
                    <section className="pr-section">
                        {overview || !pr.body.trim()
                            ? <div className="section-title">Description{pr.viewerCanUpdate && <EditDescriptionButton onClick={() => setEditing(true)} />}</div>
                            : (
                                <div className="section-title-row">
                                    <button className="section-toggle" onClick={() => setDescriptionOpen(open => !open)}>Description</button>
                                    {pr.viewerCanUpdate && <EditDescriptionButton onClick={() => setEditing(true)} />}
                                </div>
                            )}
                        {pr.body.trim()
                            ? <Markdown className={`pr-description${descriptionOpen || overview ? ' open' : ''}`} text={pr.body} />
                            : <div className="panel-note">No description.</div>}
                    </section>
                )}

                <PullRequestMeta target={target} pr={pr} onRefresh={onRefresh} />
                {/* Without a footer, an error of a change shows here. */}
                {actionError && !editing && !hasFooter && <div className="form-error pr-section-error">{actionError}</div>}

                {conversation.length > 0 && (
                    <section className="pr-section">
                        <div className="section-title">Conversation ({conversation.length})</div>
                        {conversation.map(item => (
                            <div key={item.id} className="thread-card">
                                <div className="comment-author">
                                    {item.author ?? 'unknown'}
                                    {item.state && <span className={`tag review-${item.state.toLowerCase()}`}>{REVIEW_STATE_TEXT[item.state] ?? item.state.toLowerCase()}</span>}
                                    <span>{timeAgo(item.createdAt)}</span>
                                </div>
                                {item.body.trim() && <Markdown className="comment-body" text={item.body} />}
                            </div>
                        ))}
                    </section>
                )}

                {!overview && (
                    <section className="pr-section">
                        <PullRequestFileList target={target} pr={pr} files={files} onOpen={file => onOpenDiff(pr, file)} onError={setActionError} />
                    </section>
                )}

                <section className="pr-section">
                    <div className="section-title">
                        Review threads ({unresolved} unresolved)
                        {pr.threads.length > unresolved && (
                            <button className="link-button" onClick={() => setShowResolved(value => !value)}>
                                {showResolved ? 'Hide resolved' : 'Show resolved'}
                            </button>
                        )}
                    </div>
                    {threads.length === 0 && <div className="panel-note">No review comments.</div>}
                    {threads.map(thread => (
                        <div key={thread.id} className={`thread-card${thread.isResolved ? ' resolved' : ''}`}>
                            <button className="thread-location" onClick={() => openThread(thread)}>
                                {thread.path}{thread.line ?? thread.originalLine ? `:${thread.line ?? thread.originalLine}` : ''}
                                {thread.isOutdated && <span className="tag">outdated</span>}
                                {thread.isResolved && <span className="tag">resolved</span>}
                            </button>
                            {thread.comments.map(comment => (
                                <div key={comment.id} className="thread-comment">
                                    <div className="comment-author">{comment.author?.login ?? 'unknown'} <span>{timeAgo(comment.createdAt)}</span></div>
                                    <Markdown className="comment-body" text={comment.body} />
                                </div>
                            ))}
                            {replyTo === thread.id && (
                                <div className="reply-box">
                                    <textarea autoFocus value={replyText} placeholder="Reply" onChange={event => setReplyText(event.target.value)} />
                                    <div className="row-buttons">
                                        <button className="button" onClick={() => setReplyTo(undefined)}>Cancel</button>
                                        <button className="button primary" disabled={busy || !replyText.trim()} onClick={() => sendReply(thread)}>Reply</button>
                                    </div>
                                </div>
                            )}
                            <div className="thread-actions">
                                <button className="link-button" onClick={() => { setReplyTo(thread.id); setReplyText(''); }}>Reply</button>
                                <button className="link-button" disabled={busy} onClick={() => run(() => window.shipwarden.github.setThreadResolved(thread.id, !thread.isResolved))}>
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
            </div>

            {pr.state === 'OPEN' && (
                <div className="pr-footer">
                    {actionError && <div className="form-error">{actionError}</div>}
                    <textarea
                        className="review-body"
                        value={body}
                        placeholder="Leave a review comment"
                        onChange={event => setBody(event.target.value)}
                    />
                    {review.pending.length > 0 && <div className="panel-note">{review.pending.length} inline comment(s) go out with this review.</div>}
                    <div className="row-buttons">
                        <button className="button" disabled={busy || (!body.trim() && review.pending.length === 0)} onClick={() => submit('COMMENT')}>Comment</button>
                        {!pr.viewerDidAuthor && (
                            <>
                                <button className="button" disabled={busy} onClick={() => submit('REQUEST_CHANGES')}>Request changes</button>
                                <button className="button approve" disabled={busy} onClick={() => submit('APPROVE')}><Check size={14} strokeWidth={2} />Approve</button>
                            </>
                        )}
                    </div>
                    {pr.autoMerge ? (
                        <div className="auto-merge-row">
                            <div className="panel-note">
                                Auto-merge is on{pr.autoMerge.enabledBy ? ` (${pr.autoMerge.enabledBy})` : ''}.
                                GitHub merges the pull request with "{MERGE_LABELS[pr.autoMerge.method]}" when all the requirements pass.
                            </div>
                            {pr.viewerCanDisableAutoMerge && (
                                <button className="button" disabled={busy} onClick={() => setAutoMerge(false)}>Disable auto-merge</button>
                            )}
                        </div>
                    ) : (pr.viewerCanMerge || pr.viewerCanEnableAutoMerge) && (
                    <>
                    <div className="merge-row">
                        <select value={method} onChange={event => setMergeMethod(event.target.value as MergeMethod)} disabled={busy}>
                            {pr.allowedMergeMethods.map(item => <option key={item} value={item}>{MERGE_LABELS[item]}</option>)}
                        </select>
                        {pr.viewerCanEnableAutoMerge && (
                            <button className="button" disabled={busy || !method} onClick={() => setAutoMerge(true)}>
                                <GitMerge size={14} strokeWidth={1.8} />Enable auto-merge
                            </button>
                        )}
                        {pr.viewerCanMerge && (
                            <button className="button merge" disabled={busy || !!blocker || !method} title={blocker} onClick={merge}>
                                <GitMerge size={14} strokeWidth={1.8} />Merge
                            </button>
                        )}
                    </div>
                    {pr.viewerCanMerge && blocker && <div className="panel-note">{blocker}</div>}
                    </>
                    )}
                    {pr.viewerCanUpdate && (
                        <div className="row-buttons">
                            {pr.isDraft ? (
                                <button className="button" disabled={busy} onClick={() => setDraft(false)}>
                                    <GitPullRequest size={14} strokeWidth={1.8} />Ready for review
                                </button>
                            ) : (
                                <button className="button" disabled={busy} onClick={() => setDraft(true)}>
                                    <GitPullRequestDraft size={14} strokeWidth={1.8} />Convert to draft
                                </button>
                            )}
                            <button className="button danger" disabled={busy} onClick={() => setState('closed')}>
                                <GitPullRequestClosed size={14} strokeWidth={1.8} />Close pull request
                            </button>
                        </div>
                    )}
                </div>
            )}
            {pr.state === 'CLOSED' && pr.viewerCanUpdate && (
                <div className="pr-footer">
                    {actionError && <div className="form-error">{actionError}</div>}
                    <div className="row-buttons">
                        <button className="button" disabled={busy} onClick={() => setState('open')}>
                            <GitPullRequest size={14} strokeWidth={1.8} />Reopen pull request
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
