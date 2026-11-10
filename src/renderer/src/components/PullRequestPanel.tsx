import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Bot, Check, ChevronRight, Circle, CircleCheck, CircleX, Ellipsis, ExternalLink, GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, MessageSquare, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { baseName, parentPath } from '@shared/files';
import { hostLabel, undecidedCount, type BranchStatus, type MergeMethod, type PullRequest, type PullRequestChange, type PullRequestFile, type RepoTarget, type ReviewEvent, type ReviewThread } from '@shared/github';
import { fileIcon } from '../files/file-icons';
import { gitHubSeenKey } from '@shared/dashboard';
import { reviewStore, useReviewState } from '../github/review-store';
import { seenStore } from '../seen-store';
import { errorText, timeAgo } from '../util';
import { Markdown } from './Markdown';
import { confirmDialog } from './ConfirmDialog';
import { DescriptionEditor, EditDescriptionButton, PullRequestMeta } from './PullRequestDetails';
import { MERGE_LABELS, MergeButton } from './MergeButton';
import { PullRequestTimeline, REVIEW_STATE_TEXT } from './PullRequestTimeline';
import { openLink } from '../links';
import type { CheckCounts } from '../github/use-check-counts';
import { mergeConditions } from './PullRequestSummary';
import { showContextMenu } from './ContextMenu';
import { CopyButton } from './CopyButton';

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
    /** The counts of the checks of the head commit, for the merge checklist of the Overview tab. */
    checks?: CheckCounts;
    /** Starts an agent review. Without it, the review card has no link for an agent review. */
    agentReview?: { running: boolean; run(): void };
}

/** The short text of the merge button in the narrow side column of the Overview tab. */
const SHORT_MERGE_LABELS: Record<MergeMethod, string> = { merge: 'Merge', squash: 'Squash', rebase: 'Rebase' };

const CONDITION_ICON = { size: 16, strokeWidth: 1.8 };

const ICON = { size: 15, strokeWidth: 1.6 };

export function StateBadge({ pr }: { pr: PullRequest }) {
    if (pr.state === 'MERGED') return <span className="pr-badge merged"><GitMerge {...ICON} />Merged</span>;
    if (pr.state === 'CLOSED') return <span className="pr-badge closed"><GitPullRequestClosed {...ICON} />Closed</span>;
    if (pr.isDraft) return <span className="pr-badge draft"><GitPullRequestDraft {...ICON} />Draft</span>;
    return <span className="pr-badge open"><GitPullRequest {...ICON} />Open</span>;
}

/** A branch name in code style, with a button that copies the name. */
export function BranchName({ name }: { name: string }) {
    return (
        <span className="branch-name">
            <code>{name}</code>
            <CopyButton text={name} title="Copy the branch name" size={12} className="icon-button branch-copy" />
        </span>
    );
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
    if (pr.mergeable === 'UNKNOWN') return `${hostLabel(pr.host)} is still checking whether the branch can merge.`;
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

/** The commits of a pull request, the newest first, with a link to each commit on the host. */
export function PullRequestCommitList({ pr }: { pr: PullRequest }) {
    return (
        <>
            {pr.commitCount > pr.commits.length && (
                <div className="panel-note">The list shows the newest {pr.commits.length} of {pr.commitCount} commits, the newest first.</div>
            )}
            <div className="pr-commit-list">
                {[...pr.commits].reverse().map(commit => (
                    <div key={commit.oid} className="pr-commit">
                        <GitCommitHorizontal size={15} strokeWidth={1.6} className="pr-commit-icon" />
                        <div className="pr-commit-main">
                            <div className="pr-commit-title" title={commit.messageHeadline}>{commit.messageHeadline}</div>
                            <div className="pr-commit-meta">{commit.author ?? 'unknown'} committed {timeAgo(commit.committedDate)}</div>
                        </div>
                        <button className="link-button pr-commit-sha" title={`Open the commit on ${hostLabel(pr.host)}`} onClick={event => openLink(commit.url, event)}>
                            {commit.abbreviatedOid}
                        </button>
                    </div>
                ))}
            </div>
        </>
    );
}

/**
 * The description of a pull request. In the panel, a long description shows only its start.
 * The title and the "Show more" button open the full text.
 */
function PullRequestDescription({ pr, overview, onEdit }: { pr: PullRequest; overview: boolean; onEdit(): void }) {
    const [open, setOpen] = useState(false);
    const [overflows, setOverflows] = useState(false);
    const box = useRef<HTMLDivElement>(null);
    const body = pr.body.trim();

    // Measure the closed text. The button shows only when the text is longer than the closed height.
    useLayoutEffect(() => {
        const element = box.current;
        if (!element || open || overview) return;
        const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [pr.body, open, overview]);

    const editButton = pr.viewerCanUpdate && <EditDescriptionButton onClick={onEdit} />;
    if (overview || !body) {
        return (
            <section className="pr-section">
                <div className="section-title">Description{editButton}</div>
                {body ? <Markdown className="pr-description open" text={pr.body} /> : <div className="panel-note">No description.</div>}
            </section>
        );
    }
    const toggleable = open || overflows;
    return (
        <section className="pr-section">
            <div className="section-title-row">
                {toggleable
                    ? (
                        <button className="section-toggle" aria-expanded={open} title={open ? 'Show less' : 'Show the full description'} onClick={() => setOpen(value => !value)}>
                            <ChevronRight size={13} strokeWidth={1.8} className={`section-chevron${open ? ' open' : ''}`} />Description
                        </button>
                    )
                    : <div className="section-title">Description</div>}
                {editButton}
            </div>
            <div ref={box} className={`pr-description${open ? ' open' : ''}${!open && overflows ? ' clipped' : ''}`}>
                <Markdown text={pr.body} />
            </div>
            {toggleable && (
                <button className="link-button pr-description-more" onClick={() => setOpen(value => !value)}>
                    {open ? 'Show less' : 'Show more'}
                </button>
            )}
        </section>
    );
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

/** The review events of GitHub, in the order of the buttons. */
const GITHUB_REVIEW_EVENTS: ReviewEvent[] = ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'];

/** The text of each review event in the confirmation and on its button. */
const REVIEW_EVENT_TEXT: Record<ReviewEvent, { confirm: string; button: string }> = {
    COMMENT: { confirm: 'comment on', button: 'Comment' },
    REQUEST_CHANGES: { confirm: 'request changes on', button: 'Request changes' },
    APPROVE: { confirm: 'approve', button: 'Approve' },
    APPROVE_WITH_SUGGESTIONS: { confirm: 'approve with suggestions', button: 'Approve with suggestions' },
    WAIT_FOR_AUTHOR: { confirm: 'wait for the author on', button: 'Wait for author' },
    REJECT: { confirm: 'reject', button: 'Reject' }
};

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
            .filter(review => review.body.trim() || (review.state !== 'COMMENTED' && review.state !== 'DISMISSED'))
            .map(review => ({ id: review.id, author: review.author?.login ?? null, body: review.body, createdAt: review.submittedAt ?? '', state: review.state }))
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function PullRequestPanel({ target, status, loading, error, onRefresh, onOpenDiff, onSendToAgent, variant = 'panel', checks, agentReview }: Props) {
    const overview = variant === 'overview';
    const pr = status?.pullRequest ?? null;
    const review = useReviewState(target, pr?.number);
    // The review text is in the store, so it stays when the user changes tabs, and an agent review can add to it.
    const body = review.body;
    const setBody = (value: string) => pr && reviewStore.setBody(target, pr.number, value);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<string>();
    const [mergeMethod, setMergeMethod] = useState<MergeMethod>();
    const [replyTo, setReplyTo] = useState<string>();
    const [replyText, setReplyText] = useState('');
    const [showResolved, setShowResolved] = useState(false);
    const [commitsOpen, setCommitsOpen] = useState(false);
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
        return <div className="panel-message">This worktree has no GitHub or Azure Repos remote named "origin".</div>;
    }
    if (!pr) {
        return <CreatePullRequest target={target} status={status} onCreated={onRefresh} />;
    }

    const files = review.files;
    const threads = pr.threads.filter(thread => showResolved || !thread.isResolved);
    const conversation = overview ? [] : conversationOf(pr);
    const unresolved = pr.threads.filter(thread => !thread.isResolved).length;
    const blocker = mergeBlocker(pr);
    const method = mergeMethod && pr.allowedMergeMethods.includes(mergeMethod)
        ? mergeMethod
        : pr.allowedMergeMethods.includes(pr.defaultMergeMethod) ? pr.defaultMergeMethod : pr.allowedMergeMethods[0];

    const undecided = undecidedCount(review.pending);
    const firstUndecided = review.pending.find(comment => comment.needsDecision);
    const firstUndecidedFile = firstUndecided && files?.find(file => file.path === firstUndecided.path);

    const submit = async (event: ReviewEvent) => {
        if (undecided > 0) return;
        const pending = review.pending.length ? ` with ${review.pending.length} inline comment(s)` : '';
        if (!(await confirmDialog({ title: `Submit a review to ${hostLabel(pr.host)}: ${REVIEW_EVENT_TEXT[event].confirm} pull request #${pr.number}${pending}?`, confirmLabel: 'Submit review' }))) {
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

    /** The actions that the user seldom needs: convert to draft and close. They are in a menu, away from the merge button. */
    const moreActions = async (button: Element) => {
        const choice = await showContextMenu([
            ...(pr.isDraft ? [] : [{ id: 'draft', label: 'Convert to Draft' }, { type: 'separator' as const }]),
            { id: 'close', label: 'Close Pull Request', danger: true }
        ], button);
        if (choice === 'draft') await setDraft(true);
        if (choice === 'close') await setState('closed');
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

    const events = (pr.reviewEvents ?? GITHUB_REVIEW_EVENTS).filter(event => event === 'COMMENT' || !pr.viewerDidAuthor);
    const canComment = events.includes('COMMENT') && !busy && undecided === 0 && (!!body.trim() || review.pending.length > 0);
    // ⌘↵ in the review text submits a comment without a decision.
    const onReviewKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && event.metaKey && canComment) {
            event.preventDefault();
            void submit('COMMENT');
        }
    };
    const eventButton = (event: ReviewEvent) => event === 'COMMENT' ? (
        <button key={event} className="button" disabled={!canComment} onClick={() => submit(event)}>Comment</button>
    ) : event === 'APPROVE' ? (
        <button key={event} className="button approve" disabled={busy || undecided > 0} onClick={() => submit(event)}><Check size={14} strokeWidth={2} />Approve</button>
    ) : (
        <button key={event} className="button" disabled={busy || undecided > 0} onClick={() => submit(event)}>{REVIEW_EVENT_TEXT[event].button}</button>
    );
    // The Overview tab shows the decisions as large buttons. A comment needs only ⌘↵, unless it is the only choice.
    const decisions = overview && events.some(event => event !== 'COMMENT') ? events.filter(event => event !== 'COMMENT') : events;
    const pendingPill = review.pending.length > 0 && (
        <span className="pending-pill" title="These comments go out with this review.">
            <MessageSquare size={12} strokeWidth={1.8} />
            {review.pending.length} pending comment{review.pending.length === 1 ? '' : 's'}
        </span>
    );
    const undecidedNote = undecided > 0 && (
        <div className="panel-note review-undecided">
            Accept or remove the {undecided} agent comment{undecided === 1 ? '' : 's'} that you did not check yet. Then you can submit your review.
            {firstUndecided && firstUndecidedFile && (
                <>
                    {' '}<button className="link-button" onClick={() => onOpenDiff(pr, firstUndecidedFile, firstUndecided.line)}>Show the first one</button>
                </>
            )}
        </div>
    );

    const reviewCard = overview ? (
        <section className="side-card review-card" aria-label="Your review">
            <header className="side-card-header">
                <span className="side-card-title">Your review</span>
                <span className="header-spacer" />
                {pr.viewerIsRequested && <span className="review-requested">Requested from you</span>}
            </header>
            {pendingPill && <div>{pendingPill}</div>}
            <label className="side-card-field">
                <span>Summary (optional)</span>
                <textarea
                    className="review-body"
                    value={body}
                    placeholder={pr.author?.login ? `Leave a note for ${pr.author.login}…` : 'Leave a note…'}
                    onChange={event => setBody(event.target.value)}
                    onKeyDown={onReviewKey}
                />
            </label>
            {undecidedNote}
            <div className={`review-decisions count-${decisions.length}`}>{decisions.map(eventButton)}</div>
            {(agentReview || decisions.length < events.length) && (
                <div className="review-card-foot">
                    {agentReview && (
                        <button
                            className="link-button"
                            title="An agent reviews the changes. You accept or remove each of its comments. Nothing goes to GitHub until you submit the review."
                            disabled={agentReview.running}
                            onClick={agentReview.run}
                        >
                            {agentReview.running ? <LoaderCircle size={13} className="spin" /> : <Bot size={13} strokeWidth={1.6} />}
                            {agentReview.running ? 'The agent reviews the changes…' : 'Run agent review first'}
                        </button>
                    )}
                    <span className="header-spacer" />
                    {decisions.length < events.length && (
                        <span className="review-shortcut" title="Press ⌘↵ in the summary to submit a comment without a decision.">Comment only: ⌘↵</span>
                    )}
                </div>
            )}
        </section>
    ) : (
        <section className="footer-card review-card" aria-label="Your review">
            <header className="footer-card-header">
                <span className="footer-card-title">Your review</span>
                {pendingPill}
            </header>
            <textarea
                className="review-body"
                value={body}
                placeholder="Write a summary of your review (optional)"
                onChange={event => setBody(event.target.value)}
                onKeyDown={onReviewKey}
            />
            {undecidedNote}
            <div className="review-actions">{events.map(eventButton)}</div>
        </section>
    );

    const canAct = !!(pr.autoMerge || pr.viewerCanMerge || pr.viewerCanEnableAutoMerge || pr.viewerCanUpdate);
    const moreButton = pr.viewerCanUpdate && (
        <button className="icon-button" title="More actions" aria-label="More actions" aria-haspopup="menu" disabled={busy} onClick={event => void moreActions(event.currentTarget)}>
            <Ellipsis size={15} strokeWidth={1.8} />
        </button>
    );
    const conditions = overview ? mergeConditions(pr, checks) : [];
    const onlyReviewBlocks = conditions.every(item => item.state === 'ok' || item.text === 'Approving review required');
    const mergeActions = pr.autoMerge ? (
        <>
            <div className="panel-note">
                Auto-merge is on{pr.autoMerge.enabledBy ? ` (${pr.autoMerge.enabledBy})` : ''}.
                GitHub merges the pull request with "{MERGE_LABELS[pr.autoMerge.method]}" when all the requirements pass.
            </div>
            {pr.viewerCanDisableAutoMerge && (
                <div className="merge-row">
                    <button className="button" disabled={busy} onClick={() => setAutoMerge(false)}>Disable auto-merge</button>
                </div>
            )}
        </>
    ) : (pr.viewerCanMerge || pr.viewerCanEnableAutoMerge) && (
        <>
            {!overview && pr.viewerCanMerge && blocker && <div className="panel-note">{blocker}</div>}
            {method && (
                <div className="merge-row">
                    {pr.viewerCanMerge && pr.viewerCanEnableAutoMerge && (
                        <button className="button auto-merge-button" disabled={busy} onClick={() => setAutoMerge(true)}>
                            {!overview && <GitMerge size={14} strokeWidth={1.8} />}
                            {overview && onlyReviewBlocks && pr.reviewDecision === 'REVIEW_REQUIRED' ? 'Auto-merge on approval' : 'Enable auto-merge'}
                        </button>
                    )}
                    <MergeButton
                        methods={pr.allowedMergeMethods}
                        method={method}
                        label={pr.viewerCanMerge ? (overview ? SHORT_MERGE_LABELS[method] : undefined) : 'Enable auto-merge'}
                        disabled={busy || (pr.viewerCanMerge && !!blocker)}
                        title={pr.viewerCanMerge ? blocker : undefined}
                        onSelect={setMergeMethod}
                        onRun={pr.viewerCanMerge ? merge : () => setAutoMerge(true)}
                    />
                </div>
            )}
        </>
    );
    const readyButton = pr.viewerCanUpdate && pr.isDraft && (
        <div className="merge-row">
            <button className="button" disabled={busy} onClick={() => setDraft(false)}>
                <GitPullRequest size={14} strokeWidth={1.8} />Ready for review
            </button>
        </div>
    );

    const mergeCard = overview ? (
        <section className="side-card merge-card" aria-label="Merge">
            <header className="side-card-header">
                <span className="side-card-title">{conditions.every(item => item.state === 'ok') ? 'Ready to merge' : 'Ready to merge?'}</span>
                <span className="header-spacer" />
                {moreButton}
            </header>
            <ul className="merge-conditions">
                {conditions.map(item => (
                    <li key={item.text} className={`merge-condition ${item.state}`}>
                        {item.state === 'ok' ? <CircleCheck {...CONDITION_ICON} /> : item.state === 'fail' ? <CircleX {...CONDITION_ICON} /> : <Circle {...CONDITION_ICON} />}
                        {item.text}
                    </li>
                ))}
            </ul>
            {mergeActions}
            {readyButton}
        </section>
    ) : canAct && (
        <section className="footer-card merge-card" aria-label="Merge">
            <header className="footer-card-header">
                <span className="footer-card-title">Merge</span>
                <span className="header-spacer" />
                {moreButton}
            </header>
            {mergeActions}
            {readyButton}
        </section>
    );

    const descriptionPart = editing ? (
        <section className="pr-section">
            <div className="section-title">Edit the title and the description</div>
            {actionError && <div className="form-error pr-section-error">{actionError}</div>}
            <DescriptionEditor pr={pr} busy={busy} onSave={saveDescription} onCancel={() => setEditing(false)} />
        </section>
    ) : (pr.body.trim() || overview || pr.viewerCanUpdate) && (
        <PullRequestDescription pr={pr} overview={overview} onEdit={() => setEditing(true)} />
    );
    const metaPart = <PullRequestMeta target={target} pr={pr} onRefresh={onRefresh} />;
    // Without a footer, an error of a change shows here.
    const changeError = actionError && !editing && !hasFooter && <div className="form-error pr-section-error">{actionError}</div>;
    const threadsPart = (
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
                        <button className="link-button" disabled={busy} onClick={() => run(() => window.shipwarden.github.setThreadResolved(target, thread.id, !thread.isResolved))}>
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

    return (
        <div className="pr-panel">
            <div className="pr-scroll">
                {!overview && <div className="pr-header">
                    <div className="pr-title-row">
                        <StateBadge pr={pr} />
                        <ConflictBadge pr={pr} />
                        <button className="link-button" title={`Open on ${hostLabel(pr.host)}`} onClick={event => openLink(pr.url, event)}>
                            #{pr.number} <ExternalLink size={12} strokeWidth={1.6} />
                        </button>
                        <button className="icon-button pr-refresh" title="Refresh" onClick={() => onRefresh()}>
                            <RefreshCw size={14} strokeWidth={1.6} className={loading ? 'spin' : ''} />
                        </button>
                    </div>
                    <h3 className="pr-title">{pr.title}</h3>
                    <div className="pr-meta">
                        {pr.author?.login ?? 'unknown'} {pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'wanted to merge' : 'wants to merge'} into <code>{pr.baseRefName}</code> from <BranchName name={pr.headRefName} />
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

                {overview ? (
                    <div className="pr-overview-columns">
                        <div className="pr-overview-main">
                            {descriptionPart}
                            {changeError}
                            <PullRequestTimeline pr={pr} />
                            {threadsPart}
                        </div>
                        <aside className="pr-overview-aside">
                            {pr.state === 'OPEN' && (
                                <>
                                    {actionError && <div className="form-error">{actionError}</div>}
                                    {reviewCard}
                                    {mergeCard}
                                </>
                            )}
                            <PullRequestMeta target={target} pr={pr} onRefresh={onRefresh} card />
                        </aside>
                    </div>
                ) : <>
                {descriptionPart}
                {metaPart}
                {changeError}

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

                {!overview && pr.commits.length > 0 && (
                    <section className="pr-section">
                        <button className="section-toggle" aria-expanded={commitsOpen} onClick={() => setCommitsOpen(value => !value)}>
                            <ChevronRight size={13} strokeWidth={1.8} className={`section-chevron${commitsOpen ? ' open' : ''}`} />Commits ({pr.commitCount})
                        </button>
                        {commitsOpen && <div className="pr-panel-commits"><PullRequestCommitList pr={pr} /></div>}
                    </section>
                )}

                {!overview && (
                    <section className="pr-section">
                        <PullRequestFileList target={target} pr={pr} files={files} onOpen={file => onOpenDiff(pr, file)} onError={setActionError} />
                    </section>
                )}

                {threadsPart}
                </>}
            </div>

            {pr.state === 'OPEN' && !overview && (
                <div className="pr-footer">
                    {actionError && <div className="form-error pr-footer-error">{actionError}</div>}
                    {reviewCard}
                    {mergeCard}
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

/** The form that creates a pull request for the branch of a worktree, on GitHub or Azure DevOps. */
function CreatePullRequest({ target, status, onCreated }: { target: RepoTarget; status: BranchStatus; onCreated(): Promise<void> }) {
    const [title, setTitle] = useState(status.branch);
    const [body, setBody] = useState('');
    const [draft, setDraft] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const host = hostLabel(status.host);
    const webUrl = status.createUrl ?? `https://github.com/${status.repo.owner}/${status.repo.name}/compare/${encodeURIComponent(status.branch)}?expand=1`;

    const create = async () => {
        if (typeof target !== 'string' || !title.trim()) return;
        if (!(await confirmDialog({ title: `Create a ${draft ? 'draft ' : ''}pull request on ${host} for ${status.branch}?`, confirmLabel: 'Create pull request' }))) {
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            await window.shipwarden.github.createPullRequest(target, { title: title.trim(), body, draft });
            await onCreated();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="panel-message pr-create">
            <p>No pull request for <code>{status.branch}</code>. Push the branch before you create one.</p>
            {typeof target === 'string' && (
                <div className="pr-create-form">
                    <input value={title} placeholder="Title" onChange={event => setTitle(event.target.value)} disabled={busy} />
                    <textarea className="review-body" value={body} placeholder="Description" onChange={event => setBody(event.target.value)} disabled={busy} />
                    <label className="scope-option">
                        <input type="checkbox" checked={draft} onChange={event => setDraft(event.target.checked)} disabled={busy} />
                        Draft
                    </label>
                    {error && <div className="form-error">{error}</div>}
                    <div className="row-buttons">
                        <button className="button approve" disabled={busy || !title.trim()} onClick={create}>
                            <GitPullRequest {...ICON} />Create pull request
                        </button>
                        <button className="button" onClick={event => openLink(webUrl, event)}>
                            Create on {host} <ExternalLink {...ICON} />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
