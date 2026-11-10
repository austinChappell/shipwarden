import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Bot, ChevronRight, CircleX, ExternalLink, GitPullRequest, Maximize2, RefreshCw, TriangleAlert } from 'lucide-react';
import {
    hostLabel,
    undecidedCount,
    type BranchStatus,
    type CheckRun,
    type DiffSide,
    type MergeMethod,
    type PullRequest,
    type PullRequestChange,
    type PullRequestFile,
    type RepoTarget,
    type ReviewEvent,
    type ReviewThread
} from '@shared/github';
import { gitHubSeenKey } from '@shared/dashboard';
import { reviewStore, useReviewState } from '../github/review-store';
import { seenStore } from '../seen-store';
import { errorText, optionalErrorText, timeAgo } from '../util';
import { changePullRequest, mergePullRequest, submitReview } from '../github/pull-request-mutations';
import { confirmDialog } from './ConfirmDialog';
import { DescriptionEditor, PullRequestMeta } from './PullRequestDetails';
import { PullRequestTimeline } from './PullRequestTimeline';
import { openLink } from '../links';
import { useCheckCounts, type CheckCounts } from '../github/use-check-counts';
import { showContextMenu } from './ContextMenu';
import { conflictPrompt, threadLine } from '../github/agent-prompts';
import { bannerChecks, failedCheckNames, failedChecksTitle } from '../github/check-summary';
import {
    autoMergeConfirm,
    descriptionChange,
    draftConfirm,
    hasConflicts,
    hasFooter,
    mergeConfirmTitle,
    MERGE_LABELS,
    reviewText,
    selectMergeMethod,
    stateConfirm
} from '../github/merge-state';
import { conversationOf, reviewConfirmTitle, shownCommentIds } from '../github/review-state';
import { CreatePullRequest } from './CreatePullRequest';
import { BranchName, ConflictBadge, PullRequestCommitList, PullRequestDescription, PullRequestFileList, StateBadge } from './PullRequestParts';
import { HelmLoader } from './HelmLoader';
import { PullRequestMergeCard } from './PullRequestMergeCard';
import { PullRequestReviewCard } from './PullRequestReviewCard';
import { PullRequestConversation, PullRequestThreads } from './PullRequestThreads';

export { BranchName, ConflictBadge, PullRequestCommitList, PullRequestFileList, StateBadge } from './PullRequestParts';
export { hasConflicts, reviewText } from '../github/merge-state';

interface Props {
    /** The worktree of the branch, or the repository in the Review view. */
    target: RepoTarget;
    status: BranchStatus | null | undefined;
    loading: boolean;
    error?: string;
    /** Loads the pull request again, for the Refresh button. A change from the panel updates the cache and does not call it. */
    onRefresh(): Promise<void>;
    onOpenDiff(pr: PullRequest, file: PullRequestFile, line?: number, side?: DiffSide): void;
    /**
     * Sends a prompt to the agent of the worktree, for a review thread or the merge conflicts.
     * Without it, the threads and the conflicts banner have no "Send to agent" button.
     */
    onSendToAgent?(prompt: string): void;
    /** Sends the failed checks to the agent of the worktree. Without it, the CI banner has no "Send to agent" button. */
    onSendChecksToAgent?(checks: CheckRun[]): void;
    /**
     * "panel" is the full panel of a worktree. "overview" is the Overview tab of the Review view:
     * no header and no file list (the view shows them), and the description is open.
     */
    variant?: 'panel' | 'overview';
    /** The counts of the checks of the head commit, for the merge checklist of the Overview tab. */
    checks?: CheckCounts;
    /** Starts an agent review. Without it, the review card has no link for an agent review. */
    agentReview?: { running: boolean; run(): void };
    /** Opens the pull request in the Review view. Without it, the header has no "Open in Review" button. */
    onOpenInReview?(pr: PullRequest): void;
}

export function PullRequestPanel({
    target,
    status,
    loading,
    error,
    onRefresh,
    onOpenDiff,
    onSendToAgent,
    onSendChecksToAgent,
    variant = 'panel',
    checks: givenChecks,
    agentReview,
    onOpenInReview
}: Props) {
    const overview = variant === 'overview';
    const pr = status?.pullRequest ?? null;
    // Without counts from the parent, the panel loads the checks itself, for the CI banner.
    const ownChecks = useCheckCounts(target, givenChecks ? undefined : status?.sha);
    const checks = givenChecks ?? ownChecks;
    const failedChecks = bannerChecks(pr, checks);
    const review = useReviewState(target, pr?.number);
    // The review text is in the store, so it stays when the user changes tabs, and an agent review can add to it.
    const body = review.body;
    const setBody = (value: string) => pr && reviewStore.setBody(target, pr.number, value);
    // One mutation runs the changes of the panel, so the panel has one busy state and one error.
    const action = useMutation({ mutationFn: (change: () => Promise<void>) => change() });
    const busy = action.isPending;
    /** An error of the file list. A new change clears it. */
    const [filesError, setFilesError] = useState<string>();
    const actionError = optionalErrorText(action.error) ?? filesError;
    const [mergeMethod, setMergeMethod] = useState<MergeMethod>();
    const [showResolved, setShowResolved] = useState(false);
    const [commitsOpen, setCommitsOpen] = useState(false);
    const [editing, setEditing] = useState(false);

    // A different pull request closes the editor.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The effect closes the editor when the pull request changes.
    useEffect(() => setEditing(false), [pr?.number, pr?.url]);

    const prNumber = pr?.number;
    // biome-ignore lint/correctness/useExhaustiveDependencies: A new head commit loads the file list again.
    useEffect(() => {
        if (prNumber !== undefined) {
            reviewStore.loadFiles(target, prNumber).catch(err => setFilesError(errorText(err)));
        }
    }, [target, prNumber, pr?.headRefOid]);

    // The comments that the panel shows count as seen on the Dashboard.
    useEffect(() => {
        if (!pr) return;
        seenStore.mark(shownCommentIds(pr, showResolved).map(gitHubSeenKey));
    }, [pr, showResolved]);

    /** Runs a change on the host. The change puts its result into the cache, so the panel shows it without a new load. */
    const run = async (change: () => Promise<void>) => {
        setFilesError(undefined);
        // The mutation keeps the error, and the panel shows it.
        await action.mutateAsync(change).catch(() => undefined);
    };

    if (status === undefined) {
        if (!error && loading) return <HelmLoader label="Loading the pull request" />;
        return <div className="panel-message">{error ?? ''}</div>;
    }
    if (status === null) {
        return <div className="panel-message">This worktree has no GitHub or Azure Repos remote named "origin".</div>;
    }
    if (!pr) {
        return <CreatePullRequest target={target} status={status} />;
    }

    const files = review.files;
    const conversation = overview ? [] : conversationOf(pr);
    const method = selectMergeMethod(pr, mergeMethod);

    const submit = async (event: ReviewEvent) => {
        if (undecidedCount(review.pending) > 0) return;
        if (!(await confirmDialog({ title: reviewConfirmTitle(pr, event, review.pending.length), confirmLabel: 'Submit review' }))) {
            return;
        }
        run(async () => {
            await submitReview(target, pr, event, body.trim(), review.pending);
            reviewStore.clearPending(target, pr.number);
            setBody('');
        });
    };

    const merge = async () => {
        if (method && (await confirmDialog({ title: mergeConfirmTitle(pr, method), confirmLabel: MERGE_LABELS[method] }))) {
            run(() => mergePullRequest(target, pr, method, typeof target === 'string' ? status.repo : target));
        }
    };

    /** The actions that the user seldom needs: convert to draft and close. They are in a menu, away from the merge button. */
    const moreActions = async (button: Element) => {
        const choice = await showContextMenu(
            [
                ...(pr.isDraft ? [] : [{ id: 'draft', label: 'Convert to Draft' }, { type: 'separator' as const }]),
                { id: 'close', label: 'Close Pull Request', danger: true }
            ],
            button
        );
        if (choice === 'draft') await setDraft(true);
        if (choice === 'close') await setState('closed');
    };

    const change = (value: PullRequestChange) => run(() => changePullRequest(target, pr, value));

    const setState = async (state: 'open' | 'closed') => {
        if (await confirmDialog(stateConfirm(pr, state))) {
            change({ kind: 'details', state });
        }
    };

    const setDraft = async (draft: boolean) => {
        if (await confirmDialog(draftConfirm(pr, draft))) {
            change({ kind: 'draft', pullRequestId: pr.id, draft });
        }
    };

    const setAutoMerge = async (on: boolean) => {
        if (on && !method) return;
        const autoMethod = on ? method! : null;
        if (await confirmDialog(autoMergeConfirm(pr, autoMethod))) {
            change({ kind: 'autoMerge', pullRequestId: pr.id, method: autoMethod, headSha: pr.headRefOid });
        }
    };

    const saveDescription = (title: string, text: string) =>
        run(async () => {
            await changePullRequest(target, pr, descriptionChange(pr, title, text));
            setEditing(false);
        });

    const openThread = (thread: ReviewThread) => {
        const file = files?.find(item => item.path === thread.path);
        if (file) {
            onOpenDiff(pr, file, threadLine(thread) ?? undefined, thread.side);
        }
    };

    const reviewCard = (
        <PullRequestReviewCard
            pr={pr}
            overview={overview}
            body={body}
            onBody={setBody}
            pending={review.pending}
            files={files}
            busy={busy}
            onSubmit={event => void submit(event)}
            onOpenDiff={onOpenDiff}
            agentReview={agentReview}
        />
    );
    const mergeCard = (
        <PullRequestMergeCard
            pr={pr}
            overview={overview}
            checks={checks}
            busy={busy}
            method={method}
            onSelectMethod={setMergeMethod}
            onMerge={merge}
            onAutoMerge={setAutoMerge}
            onDraft={setDraft}
            onMoreActions={button => void moreActions(button)}
        />
    );

    const descriptionPart = editing ? (
        <section className="pr-section">
            <div className="section-title">Edit the title and the description</div>
            {actionError && <div className="form-error pr-section-error">{actionError}</div>}
            <DescriptionEditor pr={pr} busy={busy} onSave={saveDescription} onCancel={() => setEditing(false)} />
        </section>
    ) : (
        (pr.body.trim() || overview || pr.viewerCanUpdate) && <PullRequestDescription pr={pr} overview={overview} onEdit={() => setEditing(true)} />
    );
    const metaPart = <PullRequestMeta target={target} pr={pr} onRefresh={onRefresh} />;
    // Without a footer, an error of a change shows here.
    const changeError = actionError && !editing && !hasFooter(pr) && <div className="form-error pr-section-error">{actionError}</div>;
    const threadsPart = (
        <PullRequestThreads
            target={target}
            pr={pr}
            showResolved={showResolved}
            onShowResolved={setShowResolved}
            busy={busy}
            run={run}
            onOpen={openThread}
            onSendToAgent={onSendToAgent}
        />
    );

    return (
        <div className="pr-panel">
            <div className="pr-scroll">
                {!overview && (
                    <div className="pr-header">
                        <div className="pr-title-row">
                            <StateBadge pr={pr} />
                            <ConflictBadge pr={pr} />
                            <button className="link-button" title={`Open on ${hostLabel(pr.host)}`} onClick={event => openLink(pr.url, event)}>
                                #{pr.number} <ExternalLink size={12} strokeWidth={1.6} />
                            </button>
                            {onOpenInReview && pr.host !== 'azure' && (
                                <button className="icon-button" title="Open in Review" onClick={() => onOpenInReview(pr)}>
                                    <Maximize2 size={14} strokeWidth={1.6} />
                                </button>
                            )}
                            <button className="icon-button pr-refresh" title="Refresh" onClick={() => onRefresh()}>
                                <RefreshCw size={14} strokeWidth={1.6} className={loading ? 'spin' : ''} />
                            </button>
                        </div>
                        <h3 className="pr-title">{pr.title}</h3>
                        <div className="pr-meta">
                            {pr.author?.login ?? 'unknown'} {pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'wanted to merge' : 'wants to merge'}{' '}
                            into <code>{pr.baseRefName}</code> from <BranchName name={pr.headRefName} />
                        </div>
                        <div className="pr-meta">
                            <span className="additions">+{pr.additions}</span> <span className="deletions">−{pr.deletions}</span>
                            <span className="dot-separator">·</span>
                            {reviewText(pr)}
                            <span className="dot-separator">·</span>
                            {timeAgo(pr.createdAt)}
                        </div>
                    </div>
                )}

                {hasConflicts(pr) && (
                    <div className="pr-conflict-banner" role="alert">
                        <TriangleAlert size={16} strokeWidth={1.8} />
                        <div className="pr-conflict-text">
                            <strong>This branch has merge conflicts.</strong>
                            <span>
                                Resolve the conflicts with <code>{pr.baseRefName}</code> before you merge.
                            </span>
                        </div>
                        {onSendToAgent && (
                            <button className="button" onClick={() => onSendToAgent(conflictPrompt(pr))}>
                                <Bot size={13} strokeWidth={1.6} /> Send to agent
                            </button>
                        )}
                    </div>
                )}

                {failedChecks.length > 0 && (
                    <div className="pr-conflict-banner" role="alert">
                        <CircleX size={16} strokeWidth={1.8} />
                        <div className="pr-conflict-text">
                            <strong>{failedChecksTitle(failedChecks.length)}</strong>
                            <span>{failedCheckNames(failedChecks)}</span>
                        </div>
                        {onSendChecksToAgent && (
                            <button className="button" onClick={() => onSendChecksToAgent(failedChecks)}>
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
                ) : (
                    <>
                        {descriptionPart}
                        {metaPart}
                        {changeError}

                        {conversation.length > 0 && <PullRequestConversation items={conversation} />}

                        {!overview && pr.commits.length > 0 && (
                            <section className="pr-section">
                                <button className="section-toggle" aria-expanded={commitsOpen} onClick={() => setCommitsOpen(value => !value)}>
                                    <ChevronRight size={13} strokeWidth={1.8} className={`section-chevron${commitsOpen ? ' open' : ''}`} />
                                    Commits ({pr.commitCount})
                                </button>
                                {commitsOpen && (
                                    <div className="pr-panel-commits">
                                        <PullRequestCommitList pr={pr} />
                                    </div>
                                )}
                            </section>
                        )}

                        {!overview && (
                            <section className="pr-section">
                                <PullRequestFileList target={target} pr={pr} files={files} onOpen={file => onOpenDiff(pr, file)} onError={setFilesError} />
                            </section>
                        )}

                        {threadsPart}
                    </>
                )}
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
                            <GitPullRequest size={14} strokeWidth={1.8} />
                            Reopen pull request
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
