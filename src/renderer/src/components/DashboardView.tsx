import { useMemo, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
    Check,
    CheckCheck,
    ChevronRight,
    ExternalLink,
    EyeOff,
    Filter,
    GitPullRequest,
    LayoutDashboard,
    MessageSquare,
    RefreshCw,
    Settings2
} from 'lucide-react';
import { EmptyState } from './EmptyState';
import {
    bucketMyPullRequests,
    DASHBOARD_STALE_DAYS,
    DASHBOARD_WINDOW_DAYS,
    gitHubSeenKey,
    groupReviewRequests,
    isHiddenComment,
    matchesDashboardQuery,
    parsePullRequestTitle,
    shortAge,
    taskSeenKey,
    type CommentFilter,
    type ReviewSort,
    type MyPullRequestItem,
    type PullRequestCommentItem,
    type ReviewRequestItem,
    type TaskCommentItem
} from '@shared/dashboard';
import { pluralize } from '@shared/format';
import type { RepoRef } from '@shared/github';
import { refreshDashboard, unseenReviewRequests, useDashboard } from '../dashboard-store';
import { applyMerged } from '../github/review-overview-store';
import { seenStore, useSeenVersion } from '../seen-store';
import { errorText, timeAgo } from '../util';
import { openLink } from '../links';
import type { ClickModifiers } from '@shared/browser';
import { Markdown } from './Markdown';
import { MERGE_LABELS } from './MergeButton';
import { confirmDialog } from './ConfirmDialog';
import { itemKeys, moveListFocus } from '../keyboard/list-nav';
import { radioGroupKeys } from './keyboard';
import { InlineTip } from './Tips';
import { Age, Button, ButtonGroup, Card, CardHeader, Chip, Count, FilterField, IconButton, PageHeader, SkeletonRows } from './ui';

export type ReviewTabRequest = 'overview' | 'checks' | 'files';

interface Props {
    /** The key of the code review accounts. Null: no account is set up, so the Dashboard has no pull requests. */
    reviewKey: string | null | undefined;
    /** Opens Settings › Code review. */
    onOpenReviewSettings(): void;
    /** The getting started checklist card. It shows at the top of the page. */
    checklist?: ReactNode;
    /** Opens a pull request in the Review view. */
    onOpenPullRequest(repo: RepoRef, number: number, tab: ReviewTabRequest): void;
    /** The hidden authors and the hiding rules of Settings > Dashboard. */
    filter: CommentFilter;
    onHideAuthor(author: string): void;
    /** Opens Settings > Dashboard with a new rule from this comment. */
    onCreateRule(author: string, text: string): void;
    onOpenSettings(): void;
}

const openUrl = (url: string | undefined, click?: ClickModifiers) => url && openLink(url, click);

/** Reads the sort of the review list. The sort stays between sessions. */
function readReviewSort(): ReviewSort {
    try {
        const value = localStorage.getItem(REVIEW_SORT_KEY);
        return value === 'oldest' || value === 'repo' ? value : 'author';
    } catch {
        return 'author';
    }
}

const REVIEW_SORT_KEY = 'shipwarden.dashboard.reviewSort';

const REVIEW_SORT_LABELS: Record<ReviewSort, string> = { author: 'By author', oldest: 'Oldest first', repo: 'By repo' };

/** An empty group (docs/design, board 4): one line of text in a dashed box. */
function Empty({ text }: { text: string }) {
    return <div className="dash-empty">{text}</div>;
}

/** A group heading in a column: a caps eyebrow and a count badge. */
function Heading({ title, count, label }: { title: string; count: number; label: string }) {
    return (
        <h2 className="dash-heading">
            {title}
            <Count value={count} label={label} />
        </h2>
    );
}

type Tone = 'review' | 'ready' | 'changes' | 'blocked' | 'stale';

/** A count at the top of the Dashboard. A click scrolls to its card. */
function StatCard({ tone, label, count, detail, onClick }: { tone: Tone; label: string; count: number | undefined; detail: string; onClick?(): void }) {
    const className = `dash-stat${count === 0 ? ' zero' : ''}`;
    const body = (
        <>
            <span className="dash-stat-label">
                <span className={`dash-dot ${tone}`} />
                {label}
            </span>
            {/* While the count loads, skeleton bars show in place of the number and the detail (docs/design, board 4). */}
            <span className="dash-stat-count">{count ?? <span className="skeleton-bar dash-stat-skeleton" aria-hidden="true" />}</span>
            <span className="dash-stat-detail">{count === undefined ? <span className="skeleton-bar" style={{ width: 96 }} /> : detail}</span>
        </>
    );
    // A card with no section to show is plain text. It gets no button, no pointer and no hover.
    if (!onClick) return <div className={className}>{body}</div>;
    return (
        <button className={`${className} clickable`} onClick={onClick}>
            {body}
        </button>
    );
}

/** A card of the user's pull requests, for one state. */
function PrCard({
    id,
    tone,
    title,
    count,
    hint,
    actions,
    children
}: {
    id: string;
    tone: Tone;
    title: string;
    count: number;
    hint?: string;
    actions?: ReactNode;
    children: ReactNode;
}) {
    return (
        <Card as="section" id={id} className="dash-pr-card">
            <CardHeader
                icon={<span className={`dash-dot ${tone}`} />}
                title={title}
                meta={
                    <>
                        <Count value={count} label={pluralize(count, 'pull request')} />
                        {hint && <span className="dash-hint">{hint}</span>}
                    </>
                }
                actions={actions}
            />
            <div className="dash-card-rows">{children}</div>
        </Card>
    );
}

/** The ticket column. A fixed width, so the IDs line up. A title without a ticket shows a "No ticket" chip. */
function Ticket({ ticket, empty = 'No ticket' }: { ticket?: string; empty?: string }) {
    return <span className={`dash-ticket${ticket ? '' : ' none'}`}>{ticket ?? (empty && <Chip tone="warning">{empty}</Chip>)}</span>;
}

/** A title in two columns: the ticket ID and the text without "fix:" and the ID. */
function Title({ title, empty }: { title: string; empty?: string }) {
    const parsed = parsePullRequestTitle(title);
    return (
        <>
            <Ticket ticket={parsed.ticket} empty={empty} />
            <span className="dash-title" title={title}>
                {parsed.text}
            </span>
        </>
    );
}

/** The repository and the number. The owner shows on hover. */
function RepoChip({ repo, number }: { repo: RepoRef; number: number }) {
    return (
        <Chip mono title={`${repo.owner}/${repo.name} #${number}`}>
            {repo.name} #{number}
        </Chip>
    );
}

/** A row of a pull request. A row is not a button, because it can have a button in it. */
function PrRow({ pr, onOpen, badges, action }: { pr: MyPullRequestItem; onOpen(): void; badges?: ReactNode; action?: ReactNode }) {
    return (
        <div className="dash-row" role="button" tabIndex={0} data-nav-item onClick={onOpen} onKeyDown={itemKeys(onOpen)}>
            <Title title={pr.title} />
            <span className="dash-chips">
                {badges}
                <RepoChip repo={pr.repo} number={pr.number} />
            </span>
            <Age className="dash-age" date={pr.updatedAt} />
            {action}
        </div>
    );
}

/** The text of the activity after the review of the user, for example "new commits and comments since you commented". */
function activityText(item: ReviewRequestItem): string {
    const activity = item.activity;
    if (!activity) return '';
    const what = activity.newCommits && activity.lastCommentAt ? 'New commits and comments' : activity.newCommits ? 'New commits' : 'New comments';
    const review: Record<string, string> = { APPROVED: 'you approved', CHANGES_REQUESTED: 'you requested changes', COMMENTED: 'you commented' };
    return `${what} since ${review[activity.reviewState] ?? 'your review'} ${timeAgo(activity.reviewedAt)}`;
}

/**
 * A row of a pull request that waits for a review of the user. A row is not a button, because it can have a button in it.
 * A row that shows because of new activity after the review of the user has a chip and a "Mark as seen" button.
 */
function ReviewRow({ pr, indented, showAuthor, onOpen }: { pr: ReviewRequestItem; indented: boolean; showAuthor: boolean; onOpen(): void }) {
    const activity = pr.activity;
    return (
        <div
            className={`dash-row dash-review-row${indented ? ' indented' : ''}`}
            role="button"
            tabIndex={0}
            data-nav-item
            onClick={onOpen}
            onKeyDown={itemKeys(onOpen)}
        >
            <span className="dash-title" title={pr.title}>
                {parsePullRequestTitle(pr.title).text}
            </span>
            {activity && (
                <Chip tone="info" title={activityText(pr)}>
                    Updated
                </Chip>
            )}
            {showAuthor && <span className="dash-person">{pr.author ?? 'unknown'}</span>}
            <RepoChip repo={pr.repo} number={pr.number} />
            <Age className="dash-age" date={pr.createdAt} />
            {activity && (
                <IconButton
                    className="dash-review-seen"
                    icon={<Check size={14} strokeWidth={2} />}
                    label={`Mark ${pr.repo.name} #${pr.number} as seen`}
                    title={`${activityText(pr)}. Mark as seen: the pull request shows again after a new commit or comment.`}
                    onClick={event => {
                        event.stopPropagation();
                        seenStore.mark([activity.seenKey]);
                    }}
                />
            )}
        </div>
    );
}

/** The chips of the problems of a pull request: failed CI and merge conflicts. */
function ProblemBadges({ pr }: { pr: MyPullRequestItem }) {
    return (
        <>
            {pr.reasons.includes('ci-failing') && <Chip tone="danger">CI failing</Chip>}
            {pr.reasons.includes('conflicts') && <Chip tone="warning">Conflict</Chip>}
        </>
    );
}

/** The chip of a comment: the review state or the file. */
function CommentLabel({ label }: { label: string }) {
    if (label === 'approved') return <Chip tone="success">Approved</Chip>;
    if (label === 'requested changes') return <Chip tone="review">Changes requested</Chip>;
    if (label === 'review') return <Chip>Review</Chip>;
    return <Chip mono>{label}</Chip>;
}

/** A comment on the Dashboard. A click shows all of it and records it as seen. */
function CommentRow({
    seenKey,
    author,
    createdAt,
    label,
    preview,
    body,
    onOpen,
    openTitle,
    onHideAuthor,
    onCreateRule
}: {
    seenKey: string;
    author: string;
    createdAt: string;
    label?: string;
    preview: string;
    body: ReactNode;
    onOpen(click?: ClickModifiers): void;
    openTitle: string;
    onHideAuthor(author: string): void;
    onCreateRule(author: string, text: string): void;
}) {
    const [open, setOpen] = useState(false);
    const seen = seenStore.has(seenKey);
    const toggle = () => {
        setOpen(value => !value);
        seenStore.mark([seenKey]);
    };
    return (
        <div className={`dash-comment${seen ? ' seen' : ''}${open ? ' open' : ''}`}>
            <div
                className="dash-comment-head"
                tabIndex={0}
                role="button"
                aria-expanded={open}
                aria-label={`Comment from ${author}`}
                data-nav-item
                onClick={toggle}
                onKeyDown={itemKeys(toggle)}
            >
                <ChevronRight size={13} strokeWidth={1.8} className={`group-chevron${open ? ' open' : ''}`} />
                {!seen && <span className="dash-unseen" title="New" />}
                <strong className="dash-author">{author}</strong>
                {label && <CommentLabel label={label} />}
                <span className="dash-preview">{open ? '' : preview}</span>
                <Age className="dash-age" date={createdAt} />
                <span className="dash-actions">
                    <IconButton
                        icon={<Filter size={14} strokeWidth={1.7} />}
                        label="Hide comments like this one with a rule"
                        onClick={event => {
                            event.stopPropagation();
                            onCreateRule(author, preview);
                        }}
                    />
                    <IconButton
                        icon={<EyeOff size={14} strokeWidth={1.7} />}
                        label={`Hide all comments from ${author}, for example an automation account`}
                        onClick={event => {
                            event.stopPropagation();
                            void confirmDialog({
                                title: `Hide all comments from "${author}" on the Dashboard?`,
                                message: 'You can show them again in Settings › Dashboard.',
                                confirmLabel: 'Hide comments'
                            }).then(ok => ok && onHideAuthor(author));
                        }}
                    />
                    <IconButton
                        icon={<ExternalLink size={14} strokeWidth={1.7} />}
                        label={openTitle}
                        onClick={event => {
                            event.stopPropagation();
                            seenStore.mark([seenKey]);
                            onOpen(event);
                        }}
                    />
                    {!seen && (
                        <IconButton
                            icon={<Check size={14} strokeWidth={2} />}
                            label="Mark as seen"
                            onClick={event => {
                                event.stopPropagation();
                                seenStore.mark([seenKey]);
                            }}
                        />
                    )}
                </span>
            </div>
            {open && <div className="dash-comment-body">{body}</div>}
        </div>
    );
}

function reviewLabel(item: PullRequestCommentItem): string | undefined {
    if (item.reviewState === 'APPROVED') return 'approved';
    if (item.reviewState === 'CHANGES_REQUESTED') return 'requested changes';
    if (item.path) return item.path.split('/').pop();
    return item.reviewState ? 'review' : undefined;
}

/** Groups items by a key, in the order of their first item. */
function groupBy<T>(items: T[], key: (item: T) => string): [string, T[]][] {
    const groups = new Map<string, T[]>();
    for (const item of items) {
        groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
    }
    return [...groups.entries()];
}

/**
 * The Dashboard: the things that need the user. Counts at the top. The user's pull requests by state on the left.
 * The review requests and the new comments on pull requests and tasks on the right.
 * A comment is new until the user sees it in ShipWarden.
 */
export function DashboardView({ reviewKey, onOpenReviewSettings, checklist, onOpenPullRequest, filter, onHideAuthor, onCreateRule, onOpenSettings }: Props) {
    const state = useDashboard();
    useSeenVersion();
    const [query, setQuery] = useState('');
    const [reviewSort, setReviewSortState] = useState<ReviewSort>(readReviewSort);
    const [staleOpen, setStaleOpen] = useState(false);
    // Comments that the user saw while the Dashboard was open stay in the list (dimmed) until the next load.
    const [shownAt] = useState(() => new Set<string>());
    const visible = (key: string) => {
        if (!seenStore.has(key)) {
            shownAt.add(key);
            return true;
        }
        return shownAt.has(key);
    };

    const setReviewSort = (sort: ReviewSort) => {
        setReviewSortState(sort);
        try {
            localStorage.setItem(REVIEW_SORT_KEY, sort);
        } catch {
            // The sort is a convenience. Without storage it resets in the next session.
        }
    };

    const pullRequests = state.pullRequests;
    const hiddenKey = JSON.stringify(filter);
    // biome-ignore lint/correctness/useExhaustiveDependencies: hiddenKey holds the content of filter. The filter object can change identity without a change in content.
    const prComments = useMemo(() => (state.prComments ?? []).filter(item => !isHiddenComment(item.author, item.text, filter)), [state.prComments, hiddenKey]);
    const unseenPr = prComments.filter(item => !seenStore.has(gitHubSeenKey(item.id)));
    const shownPrComments = prComments
        .filter(item => visible(gitHubSeenKey(item.id)))
        .filter(item => matchesDashboardQuery({ title: item.prTitle, repo: item.repo, number: item.number, author: item.author }, query));
    const taskComments = state.tasks.flatMap(source =>
        (source.comments ?? []).filter(comment => !isHiddenComment(comment.author, comment.body, filter)).map(comment => ({ source, comment }))
    );
    const unseenTask = taskComments.filter(({ source, comment }) => !seenStore.has(taskSeenKey(source.connectionId, comment.id)));
    const taskQuery = query.trim().toLowerCase();
    const shownTaskComments = taskComments
        .filter(({ source, comment }) => visible(taskSeenKey(source.connectionId, comment.id)))
        .filter(({ comment }) => !taskQuery || `${comment.taskKey ?? ''} ${comment.taskTitle} ${comment.author ?? ''}`.toLowerCase().includes(taskQuery));

    const all = useMemo(() => bucketMyPullRequests(pullRequests?.myPullRequests ?? []), [pullRequests]);
    const matches = (pr: MyPullRequestItem) => matchesDashboardQuery(pr, query);
    const buckets = {
        ready: all.ready.filter(matches),
        changes: all.changes.filter(matches),
        blocked: all.blocked.filter(matches),
        stale: all.stale.filter(matches)
    };
    const reviewRequests = unseenReviewRequests(pullRequests?.reviewRequests ?? []);
    const shownReviews = reviewRequests.filter(pr => matchesDashboardQuery(pr, query));
    const reviewGroups = groupReviewRequests(shownReviews, reviewSort);

    const hiddenCount = (filter.hiddenAuthors?.length ?? 0) + (filter.hiddenRules?.length ?? 0);
    const markAllPr = () => seenStore.mark(prComments.map(item => gitHubSeenKey(item.id)));
    const markAllTasks = () => seenStore.mark(taskComments.map(({ source, comment }) => taskSeenKey(source.connectionId, comment.id)));
    const myPrTab = (pr: MyPullRequestItem): ReviewTabRequest => (pr.reasons.includes('ci-failing') ? 'checks' : 'overview');
    const openMine = (pr: MyPullRequestItem) => onOpenPullRequest(pr.repo, pr.number, myPrTab(pr));

    /** Scrolls to the section and flashes it. The flash shows the section when the page cannot scroll. */
    const scrollTo = (id: string) => {
        if (id === 'dash-stale') setStaleOpen(true);
        const section = document.getElementById(id);
        if (!section) return;
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        section.classList.remove('dash-flash');
        void section.offsetWidth; // Restart the animation when the user clicks again.
        section.classList.add('dash-flash');
        section.addEventListener('animationend', () => section.classList.remove('dash-flash'), { once: true });
    };
    /** Gives the click handler only when the section shows rows. */
    const jumpTo = (id: string, shown: number) => (shown > 0 ? () => scrollTo(id) : undefined);

    /**
     * Merges the pull requests one after the other. GitHub refuses a merge after a new push.
     * The cached lists then drop the merged pull requests. No list loads again.
     */
    const mergeMutation = useMutation({
        mutationFn: async (prs: MyPullRequestItem[]) => {
            const merged: MyPullRequestItem[] = [];
            const errors: string[] = [];
            for (const pr of prs) {
                try {
                    await window.shipwarden.github.merge(pr.repo, pr.number, pr.headSha!, pr.mergeMethod ?? 'merge');
                    merged.push(pr);
                } catch (error) {
                    errors.push(`${pr.repo.name} #${pr.number}: ${errorText(error)}`);
                }
            }
            return { merged, errors };
        },
        onSuccess: ({ merged }) => applyMerged(merged)
    });
    const merging = mergeMutation.isPending;
    const mergeErrors = mergeMutation.data?.errors;
    const mergeError = mergeErrors?.length ? mergeErrors.join('\n') : undefined;

    /** Merges the pull requests after the user confirms. */
    const merge = async (prs: MyPullRequestItem[]) => {
        const ready = prs.filter(pr => pr.headSha);
        if (ready.length === 0) return;
        const ok = await confirmDialog({
            title: ready.length === 1 ? `Merge "${parsePullRequestTitle(ready[0].title).text}"?` : `Merge ${ready.length} pull requests?`,
            message:
                ready.length === 1
                    ? `${ready[0].repo.owner}/${ready[0].repo.name} #${ready[0].number}`
                    : ready.map(pr => `${pr.repo.name} #${pr.number}: ${parsePullRequestTitle(pr.title).text}`).join('\n'),
            confirmLabel: 'Merge'
        });
        if (!ok) return;
        mergeMutation.mutate(ready);
    };

    // The details of the counts at the top.
    const authorCounts = groupReviewRequests(reviewRequests, 'author');
    const oldestReview = groupReviewRequests(reviewRequests, 'oldest')[0]?.items[0];
    const reviewDetail =
        reviewRequests.length === 0
            ? 'Nothing waits on you'
            : [
                  authorCounts[0] && authorCounts.length > 1 ? `${authorCounts[0].items.length} from ${authorCounts[0].key}` : `From ${authorCounts[0].key}`,
                  oldestReview && `oldest ${shortAge(oldestReview.createdAt)}`
              ]
                  .filter(Boolean)
                  .join(' · ');
    const ciCount = all.blocked.filter(pr => pr.reasons.includes('ci-failing')).length;
    const conflictCount = all.blocked.filter(pr => pr.reasons.includes('conflicts')).length;
    const oldestChange = all.changes[all.changes.length - 1];
    const loaded = !!pullRequests;
    const yourCount = pullRequests?.myPullRequests.length ?? 0;
    const shownYourCount = buckets.ready.length + buckets.changes.length + buckets.blocked.length + buckets.stale.length;
    const stalePreview = buckets.stale.slice(0, 4).map(pr => parsePullRequestTitle(pr.title).text);
    const oldestStale = buckets.stale[0];
    const commentsLoaded = !!state.prComments;
    const noComments =
        commentsLoaded && !state.prCommentsError && shownPrComments.length === 0 && shownTaskComments.length === 0 && !state.tasks.some(source => source.error);

    return (
        <div className="dashboard-view">
            <PageHeader
                icon={LayoutDashboard}
                title="Dashboard"
                meta={state.updatedAt ? `Updated ${timeAgo(new Date(state.updatedAt).toISOString())}` : undefined}
                filter={<FilterField value={query} onChange={setQuery} placeholder="Filter pull requests" />}
                actions={
                    <>
                        {hiddenCount > 0 && (
                            <Button size="lg" title="Show the hidden authors and rules" onClick={onOpenSettings}>
                                {pluralize(hiddenCount, 'hiding rule')}
                            </Button>
                        )}
                        <IconButton size="lg" icon={<Settings2 size={16} strokeWidth={1.6} />} label="Dashboard settings" onClick={onOpenSettings} />
                        <IconButton
                            size="lg"
                            icon={<RefreshCw size={16} strokeWidth={1.6} className={state.loading ? 'spin' : ''} />}
                            label="Refresh"
                            onClick={() => void refreshDashboard()}
                        />
                    </>
                }
            />
            <div className="dash-scroll" onKeyDown={moveListFocus}>
                <div className="dash-page">
                    {checklist}
                    {reviewKey !== null && <InlineTip id="dashboard" />}
                    {reviewKey === null && (
                        <div className="dash-connect">
                            <EmptyState
                                icon={GitPullRequest}
                                title="Connect GitHub or Azure DevOps"
                                size="compact"
                                actions={
                                    <Button variant="primary" onClick={onOpenReviewSettings}>
                                        Open Settings › Code review
                                    </Button>
                                }
                                hint={
                                    <>
                                        For GitHub, ShipWarden can use the login of the GitHub CLI. Run <kbd>gh auth login</kbd> in a terminal.
                                    </>
                                }
                            >
                                The Dashboard shows your pull requests, the review requests, and new comments. It needs a code review account.
                            </EmptyState>
                        </div>
                    )}
                    <div className="dash-stats">
                        <StatCard
                            tone="review"
                            label="Needs your review"
                            count={pullRequests && reviewRequests.length}
                            detail={reviewDetail}
                            onClick={jumpTo('dash-review', shownReviews.length)}
                        />
                        <StatCard
                            tone="ready"
                            label="Ready to merge"
                            count={pullRequests && all.ready.length}
                            detail={all.ready.length ? 'One click each' : 'Nothing to merge'}
                            onClick={jumpTo('dash-ready', buckets.ready.length)}
                        />
                        <StatCard
                            tone="changes"
                            label="Changes requested"
                            count={pullRequests && all.changes.length}
                            detail={oldestChange ? `Oldest ${shortAge(oldestChange.updatedAt)}` : 'No changes asked'}
                            onClick={jumpTo('dash-changes', buckets.changes.length)}
                        />
                        <StatCard
                            tone="blocked"
                            label="Blocked"
                            count={pullRequests && all.blocked.length}
                            detail={
                                all.blocked.length
                                    ? [ciCount && `${ciCount} CI failing`, conflictCount && pluralize(conflictCount, 'conflict')].filter(Boolean).join(' · ')
                                    : 'CI green, no conflicts'
                            }
                            onClick={jumpTo('dash-blocked', buckets.blocked.length)}
                        />
                        <StatCard
                            tone="stale"
                            label={`Stale ${DASHBOARD_STALE_DAYS}d+`}
                            count={pullRequests && all.stale.length}
                            detail={all.stale.length ? 'Close or revive' : 'None'}
                            onClick={jumpTo('dash-stale', buckets.stale.length)}
                        />
                    </div>

                    <div className="dash-columns">
                        <div className="dash-column">
                            <Heading
                                title="Your pull requests"
                                count={query ? shownYourCount : yourCount}
                                label={query ? `${shownYourCount} of ${pluralize(yourCount, 'pull request')}` : pluralize(yourCount, 'pull request')}
                            />
                            {state.pullRequestsError && <div className="form-error">{state.pullRequestsError}</div>}
                            {!pullRequests && !state.pullRequestsError && (
                                <Card>
                                    <SkeletonRows count={4} dot={false} label="Loading your pull requests" />
                                </Card>
                            )}
                            {loaded && yourCount === 0 && <Empty text="None of your pull requests needs an action." />}
                            {loaded && yourCount > 0 && shownYourCount === 0 && <Empty text="No pull requests match the filter." />}

                            {buckets.ready.length > 0 && (
                                <PrCard
                                    id="dash-ready"
                                    tone="ready"
                                    title="Ready to merge"
                                    count={buckets.ready.length}
                                    hint="Approved, CI green, no conflicts"
                                    actions={
                                        buckets.ready.length > 1 && (
                                            <Button variant="accent" disabled={merging} onClick={() => void merge(buckets.ready)}>
                                                {buckets.ready.length === 2 ? 'Merge both' : `Merge all ${buckets.ready.length}`}
                                            </Button>
                                        )
                                    }
                                >
                                    {mergeError && <div className="form-error dash-card-error">{mergeError}</div>}
                                    {buckets.ready.map(pr => (
                                        <PrRow
                                            key={pr.url}
                                            pr={pr}
                                            onOpen={() => openMine(pr)}
                                            action={
                                                <Button
                                                    variant="accent"
                                                    className="dash-row-action"
                                                    disabled={merging || !pr.headSha}
                                                    title={pr.mergeMethod ? MERGE_LABELS[pr.mergeMethod] : undefined}
                                                    onClick={event => {
                                                        event.stopPropagation();
                                                        void merge([pr]);
                                                    }}
                                                >
                                                    Merge
                                                </Button>
                                            }
                                        />
                                    ))}
                                </PrCard>
                            )}

                            {buckets.changes.length > 0 && (
                                <PrCard
                                    id="dash-changes"
                                    tone="changes"
                                    title="Changes requested"
                                    count={buckets.changes.length}
                                    hint="Waiting on you, not the reviewer"
                                >
                                    {buckets.changes.map(pr => (
                                        <PrRow
                                            key={pr.url}
                                            pr={pr}
                                            onOpen={() => openMine(pr)}
                                            badges={
                                                <>
                                                    {!!pr.unresolvedThreads && (
                                                        <Chip icon={<MessageSquare size={12} strokeWidth={2} />}>{pr.unresolvedThreads} unresolved</Chip>
                                                    )}
                                                    <ProblemBadges pr={pr} />
                                                </>
                                            }
                                            action={
                                                <Button
                                                    className="dash-row-action"
                                                    onClick={event => {
                                                        event.stopPropagation();
                                                        onOpenPullRequest(pr.repo, pr.number, 'overview');
                                                    }}
                                                >
                                                    Open
                                                </Button>
                                            }
                                        />
                                    ))}
                                </PrCard>
                            )}

                            {buckets.blocked.length > 0 && (
                                <PrCard
                                    id="dash-blocked"
                                    tone="blocked"
                                    title="Blocked"
                                    count={buckets.blocked.length}
                                    hint={`CI failing or merge conflicts, under ${DASHBOARD_STALE_DAYS} days old`}
                                >
                                    {buckets.blocked.map(pr => (
                                        <PrRow key={pr.url} pr={pr} onOpen={() => openMine(pr)} badges={<ProblemBadges pr={pr} />} />
                                    ))}
                                </PrCard>
                            )}

                            {buckets.stale.length > 0 && (
                                <Card as="section" id="dash-stale" className={`dash-pr-card dash-stale${staleOpen ? ' open' : ''}`}>
                                    <div className="card-header">
                                        <button className="dash-stale-toggle" aria-expanded={staleOpen} onClick={() => setStaleOpen(open => !open)}>
                                            <ChevronRight size={14} strokeWidth={1.8} className={`group-chevron${staleOpen ? ' open' : ''}`} />
                                            <h3 className="card-title">Stale</h3>
                                            <Count value={buckets.stale.length} label={pluralize(buckets.stale.length, 'pull request')} />
                                            <span className="dash-hint">
                                                No update in {DASHBOARD_STALE_DAYS}+ days{oldestStale && `, oldest ${shortAge(oldestStale.updatedAt)}`}
                                            </span>
                                        </button>
                                    </div>
                                    {staleOpen ? (
                                        <div className="dash-card-rows">
                                            {buckets.stale.map(pr => (
                                                <PrRow key={pr.url} pr={pr} onOpen={() => openMine(pr)} badges={<ProblemBadges pr={pr} />} />
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="dash-stale-preview">
                                            {stalePreview.join(' · ')}
                                            {buckets.stale.length > stalePreview.length && ` · +${buckets.stale.length - stalePreview.length} more`}
                                        </div>
                                    )}
                                </Card>
                            )}
                        </div>

                        <div className="dash-column">
                            <Heading
                                title="Waiting on your review"
                                count={query ? shownReviews.length : reviewRequests.length}
                                label={
                                    query
                                        ? `${shownReviews.length} of ${pluralize(reviewRequests.length, 'review request')}`
                                        : pluralize(reviewRequests.length, 'review request')
                                }
                            />
                            <Card as="section" id="dash-review" className="dash-review-card">
                                <div className="dash-review-sort">
                                    <ButtonGroup role="radiogroup" label="Sort the review requests" onKeyDown={radioGroupKeys}>
                                        {(Object.keys(REVIEW_SORT_LABELS) as ReviewSort[]).map(sort => (
                                            <Button
                                                key={sort}
                                                role="radio"
                                                aria-checked={reviewSort === sort}
                                                tabIndex={reviewSort === sort ? 0 : -1}
                                                onClick={() => setReviewSort(sort)}
                                            >
                                                {REVIEW_SORT_LABELS[sort]}
                                            </Button>
                                        ))}
                                    </ButtonGroup>
                                </div>
                                <div className="dash-card-rows">
                                    {state.pullRequestsError && <div className="form-error">{state.pullRequestsError}</div>}
                                    {!pullRequests && !state.pullRequestsError && <SkeletonRows count={3} dot={false} label="Loading the review requests" />}
                                    {loaded && reviewRequests.length === 0 && <Empty text="No pull requests wait for your review." />}
                                    {loaded && reviewRequests.length > 0 && shownReviews.length === 0 && <Empty text="No review requests match the filter." />}
                                    {reviewGroups.map(group => (
                                        <div key={group.key || 'all'} className="dash-review-group">
                                            {group.key && (
                                                <div className="dash-review-group-head">
                                                    {reviewSort === 'author' && <span className="dash-avatar">{group.key.charAt(0).toUpperCase()}</span>}
                                                    <strong>{group.key}</strong>
                                                    <Count value={group.items.length} label={pluralize(group.items.length, 'pull request')} />
                                                </div>
                                            )}
                                            {group.items.map(pr => (
                                                <ReviewRow
                                                    key={pr.url}
                                                    pr={pr}
                                                    indented={!!group.key}
                                                    showAuthor={reviewSort !== 'author'}
                                                    onOpen={() => onOpenPullRequest(pr.repo, pr.number, 'files')}
                                                />
                                            ))}
                                        </div>
                                    ))}
                                </div>
                            </Card>

                            {!commentsLoaded && !state.prCommentsError && (
                                <Card>
                                    <SkeletonRows count={3} dot={false} label="Loading comments" />
                                </Card>
                            )}
                            {noComments && (
                                <Empty
                                    text={
                                        query
                                            ? 'No new comments match the filter.'
                                            : `No new ${state.tasks.length ? 'PR or task comments' : 'PR comments'} in the last ${DASHBOARD_WINDOW_DAYS} days.`
                                    }
                                />
                            )}

                            {(state.prCommentsError || shownPrComments.length > 0) && (
                                <CommentSection title="New pull request comments" count={unseenPr.length} onMarkAll={markAllPr}>
                                    {state.prCommentsError && <div className="form-error">{state.prCommentsError}</div>}
                                    {groupBy(shownPrComments, item => item.prUrl).map(([url, items]) => (
                                        <div key={url} className="dash-group">
                                            <button
                                                className="dash-row dash-group-head"
                                                data-nav-item
                                                onClick={() => onOpenPullRequest(items[0].repo, items[0].number, 'overview')}
                                            >
                                                <Title title={items[0].prTitle} empty="" />
                                                <RepoChip repo={items[0].repo} number={items[0].number} />
                                            </button>
                                            {items.map(item => (
                                                <CommentRow
                                                    key={item.id}
                                                    seenKey={gitHubSeenKey(item.id)}
                                                    author={item.author}
                                                    createdAt={item.createdAt}
                                                    label={reviewLabel(item)}
                                                    preview={item.text}
                                                    body={<Markdown className="comment-body" text={item.text} html={item.html} />}
                                                    onOpen={() => onOpenPullRequest(item.repo, item.number, item.path ? 'files' : 'overview')}
                                                    openTitle="Open the pull request"
                                                    onHideAuthor={onHideAuthor}
                                                    onCreateRule={onCreateRule}
                                                />
                                            ))}
                                        </div>
                                    ))}
                                </CommentSection>
                            )}

                            {(state.tasks.some(source => source.error) || shownTaskComments.length > 0) && (
                                <CommentSection title="New task comments" count={unseenTask.length} onMarkAll={markAllTasks}>
                                    {state.tasks
                                        .filter(source => source.error)
                                        .map(source => (
                                            <div key={source.connectionId} className="form-error">
                                                {source.name}: {source.error}
                                            </div>
                                        ))}
                                    {groupBy(shownTaskComments, ({ source, comment }) => `${source.connectionId}\0${comment.taskId}`).map(([key, items]) => {
                                        const task: TaskCommentItem = items[0].comment;
                                        return (
                                            <div key={key} className="dash-group">
                                                <button
                                                    className="dash-row dash-group-head"
                                                    data-nav-item
                                                    onClick={event => openUrl(task.taskUrl, event)}
                                                    title="Open the task in the browser"
                                                >
                                                    <Ticket ticket={task.taskKey} empty="" />
                                                    <span className="dash-title">{task.taskTitle}</span>
                                                    <Chip>{items[0].source.name}</Chip>
                                                </button>
                                                {items.map(({ source, comment }) => (
                                                    <CommentRow
                                                        key={comment.id}
                                                        seenKey={taskSeenKey(source.connectionId, comment.id)}
                                                        author={comment.author ?? 'unknown'}
                                                        createdAt={comment.createdAt}
                                                        preview={comment.body}
                                                        body={<Markdown className="comment-body" text={comment.body} />}
                                                        onOpen={click => openUrl(comment.taskId && task.taskUrl, click)}
                                                        openTitle="Open the task in the browser"
                                                        onHideAuthor={onHideAuthor}
                                                        onCreateRule={onCreateRule}
                                                    />
                                                ))}
                                            </div>
                                        );
                                    })}
                                </CommentSection>
                            )}
                            {commentsLoaded && state.tasks.length === 0 && state.updatedAt && (
                                <p className="dash-footnote">Add ClickUp in Settings › Task managers to see new task comments here.</p>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

/** A card of new comments, with a count of the comments that the user did not see. */
function CommentSection({ title, count, onMarkAll, children }: { title: string; count: number; onMarkAll(): void; children: ReactNode }) {
    return (
        <Card as="section" className="dash-comment-card">
            <CardHeader
                icon={<MessageSquare size={14} strokeWidth={1.7} />}
                title={title}
                meta={<Count value={count} label={pluralize(count, 'new comment')} />}
                actions={
                    count > 0 && (
                        <Button variant="ghost" icon={<CheckCheck size={14} strokeWidth={1.8} />} onClick={onMarkAll}>
                            Mark all as seen
                        </Button>
                    )
                }
            />
            <div className="dash-card-rows">{children}</div>
        </Card>
    );
}
