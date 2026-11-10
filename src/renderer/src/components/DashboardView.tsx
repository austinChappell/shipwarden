import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, CheckCheck, ChevronRight, CircleCheck, ExternalLink, EyeOff, Filter, LayoutDashboard, MessageSquare, RefreshCw, Search, Settings2 } from 'lucide-react';
import {
    ageLevel,
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
    type TaskCommentItem
} from '@shared/dashboard';
import type { RepoRef } from '@shared/github';
import { dashboardStore, useDashboard } from '../dashboard-store';
import { seenStore, useSeenVersion } from '../seen-store';
import { errorText, timeAgo } from '../util';
import { openLink } from '../links';
import type { ClickModifiers } from '@shared/browser';
import { Markdown } from './Markdown';
import { MERGE_LABELS } from './MergeButton';
import { SeaLoader } from './SeaLoader';
import { confirmDialog } from './ConfirmDialog';
import { itemKeys, moveListFocus } from '../keyboard/list-nav';

export type ReviewTabRequest = 'overview' | 'checks' | 'files';

interface Props {
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

/** True when the key goes to a field that takes text. Then "/" types a slash and does not move the focus to the filter. */
function isTextTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
        || (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(target.type));
}

function Empty({ text }: { text: string }) {
    return <div className="dash-empty"><CircleCheck size={14} strokeWidth={1.8} />{text}</div>;
}

type Tone = 'review' | 'ready' | 'changes' | 'blocked' | 'stale';

/** A count at the top of the Dashboard. A click scrolls to its card. */
function StatCard({ tone, label, count, detail, onClick }: { tone: Tone; label: string; count: number | undefined; detail: string; onClick(): void }) {
    return (
        <button className={`dash-stat${count === 0 ? ' zero' : ''}`} onClick={onClick}>
            <span className="dash-stat-label"><span className={`dash-dot ${tone}`} />{label}</span>
            <span className="dash-stat-count">{count ?? '–'}</span>
            <span className="dash-stat-detail">{detail}</span>
        </button>
    );
}

/** A card of the user's pull requests, for one state. */
function PrCard({ id, tone, title, count, hint, actions, children }: { id: string; tone: Tone; title: string; count: number; hint?: string; actions?: ReactNode; children: ReactNode }) {
    return (
        <section id={id} className="dash-card dash-pr-card">
            <header className="dash-card-head">
                <span className={`dash-dot ${tone}`} />
                <h3>{title}</h3>
                <span className="dash-card-count">{count}</span>
                {hint && <span className="dash-hint">{hint}</span>}
                <span className="header-spacer" />
                {actions}
            </header>
            {children}
        </section>
    );
}

/** The ticket column. A fixed width, so the IDs line up. A title without a ticket shows "no ticket". */
function Ticket({ ticket, empty = 'no ticket' }: { ticket?: string; empty?: string }) {
    return <span className={`dash-ticket${ticket ? '' : ' none'}`}>{ticket ?? (empty && <span className="dash-no-ticket">{empty}</span>)}</span>;
}

/** A title in two columns: the ticket ID and the text without "fix:" and the ID. */
function Title({ title, empty }: { title: string; empty?: string }) {
    const parsed = parsePullRequestTitle(title);
    return (
        <>
            <Ticket ticket={parsed.ticket} empty={empty} />
            <span className="dash-title" title={title}>{parsed.text}</span>
        </>
    );
}

/** The repository and the number. The owner shows on hover. */
function RepoPill({ repo, number }: { repo: RepoRef; number: number }) {
    return <span className="dash-repo" title={`${repo.owner}/${repo.name} #${number}`}>{repo.name} #{number}</span>;
}

/** The age column. The color shows how old the item is. */
function Age({ iso, title }: { iso: string; title: string }) {
    return <span className={`dash-age ${ageLevel(iso)}`} title={title}>{shortAge(iso)}</span>;
}

/** A row of a pull request. A row is not a button, because it can have a button in it. */
function PrRow({ pr, onOpen, badges, action }: { pr: MyPullRequestItem; onOpen(): void; badges?: ReactNode; action?: ReactNode }) {
    return (
        <div className="dash-row" role="button" tabIndex={0} data-nav-item onClick={onOpen} onKeyDown={itemKeys(onOpen)}>
            <Title title={pr.title} />
            {badges && <span className="dash-badges">{badges}</span>}
            <RepoPill repo={pr.repo} number={pr.number} />
            <Age iso={pr.updatedAt} title={`Updated ${timeAgo(pr.updatedAt)}`} />
            {action}
        </div>
    );
}

/** The badges of the problems of a pull request: failed CI and merge conflicts. */
function ProblemBadges({ pr }: { pr: MyPullRequestItem }) {
    return (
        <>
            {pr.reasons.includes('ci-failing') && <span className="dash-badge ci-failing">CI failing</span>}
            {pr.reasons.includes('conflicts') && <span className="dash-badge conflicts">Conflict</span>}
        </>
    );
}

/** A comment on the Dashboard. A click shows all of it and records it as seen. */
function CommentRow({ seenKey, author, createdAt, label, preview, body, onOpen, openTitle, onHideAuthor, onCreateRule }: {
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
                {label && <span className={`dash-tag ${label === 'approved' ? 'approved' : label === 'requested changes' ? 'changes' : ''}`}>{label}</span>}
                <span className="dash-preview">{open ? '' : preview}</span>
                <span className="dash-age" title={new Date(createdAt).toLocaleString()}>{shortAge(createdAt)}</span>
                <span className="dash-actions">
                    <button
                        className="icon-button dash-hide"
                        title="Hide comments like this one with a rule"
                        onClick={event => {
                            event.stopPropagation();
                            onCreateRule(author, preview);
                        }}
                    >
                        <Filter size={13} strokeWidth={1.7} />
                    </button>
                    <button
                        className="icon-button dash-hide"
                        title={`Hide all comments from ${author}, for example an automation account`}
                        onClick={event => {
                            event.stopPropagation();
                            void confirmDialog({
                                title: `Hide all comments from "${author}" on the Dashboard?`,
                                message: 'You can show them again in Settings › Dashboard.',
                                confirmLabel: 'Hide comments'
                            }).then(ok => ok && onHideAuthor(author));
                        }}
                    >
                        <EyeOff size={13} strokeWidth={1.7} />
                    </button>
                    <button className="icon-button" title={openTitle} onClick={event => { event.stopPropagation(); seenStore.mark([seenKey]); onOpen(event); }}>
                        <ExternalLink size={13} strokeWidth={1.7} />
                    </button>
                    {!seen && (
                        <button className="icon-button" title="Mark as seen" onClick={event => { event.stopPropagation(); seenStore.mark([seenKey]); }}>
                            <Check size={14} strokeWidth={2} />
                        </button>
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
export function DashboardView({ onOpenPullRequest, filter, onHideAuthor, onCreateRule, onOpenSettings }: Props) {
    const state = useDashboard();
    useSeenVersion();
    const [query, setQuery] = useState('');
    const [reviewSort, setReviewSortState] = useState<ReviewSort>(readReviewSort);
    const [staleOpen, setStaleOpen] = useState(false);
    const [merging, setMerging] = useState(false);
    const [mergeError, setMergeError] = useState<string>();
    const filterInput = useRef<HTMLInputElement>(null);
    // Comments that the user saw while the Dashboard was open stay in the list (dimmed) until the next load.
    const [shownAt] = useState(() => new Set<string>());
    const visible = (key: string) => {
        if (!seenStore.has(key)) {
            shownAt.add(key);
            return true;
        }
        return shownAt.has(key);
    };

    // "/" moves the focus to the filter, as on GitHub.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || isTextTarget(event.target)) return;
            event.preventDefault();
            filterInput.current?.focus();
            filterInput.current?.select();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

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
    const prComments = useMemo(
        () => (state.prComments ?? []).filter(item => !isHiddenComment(item.author, item.text, filter)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [state.prComments, hiddenKey]
    );
    const unseenPr = prComments.filter(item => !seenStore.has(gitHubSeenKey(item.id)));
    const shownPrComments = prComments
        .filter(item => visible(gitHubSeenKey(item.id)))
        .filter(item => matchesDashboardQuery({ title: item.prTitle, repo: item.repo, number: item.number, author: item.author }, query));
    const taskComments = state.tasks.flatMap(source => (source.comments ?? [])
        .filter(comment => !isHiddenComment(comment.author, comment.body, filter))
        .map(comment => ({ source, comment })));
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
    const reviewRequests = pullRequests?.reviewRequests ?? [];
    const shownReviews = reviewRequests.filter(pr => matchesDashboardQuery(pr, query));
    const reviewGroups = groupReviewRequests(shownReviews, reviewSort);

    const hiddenCount = (filter.hiddenAuthors?.length ?? 0) + (filter.hiddenRules?.length ?? 0);
    const markAllPr = () => seenStore.mark(prComments.map(item => gitHubSeenKey(item.id)));
    const markAllTasks = () => seenStore.mark(taskComments.map(({ source, comment }) => taskSeenKey(source.connectionId, comment.id)));
    const myPrTab = (pr: MyPullRequestItem): ReviewTabRequest => (pr.reasons.includes('ci-failing') ? 'checks' : 'overview');
    const openMine = (pr: MyPullRequestItem) => onOpenPullRequest(pr.repo, pr.number, myPrTab(pr));

    const scrollTo = (id: string) => {
        if (id === 'dash-stale') setStaleOpen(true);
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    /** Merges the pull requests one after the other, after the user confirms. GitHub refuses a merge after a new push. */
    const merge = async (prs: MyPullRequestItem[]) => {
        const ready = prs.filter(pr => pr.headSha);
        if (ready.length === 0) return;
        const ok = await confirmDialog({
            title: ready.length === 1 ? `Merge "${parsePullRequestTitle(ready[0].title).text}"?` : `Merge ${ready.length} pull requests?`,
            message: ready.length === 1
                ? `${ready[0].repo.owner}/${ready[0].repo.name} #${ready[0].number}`
                : ready.map(pr => `${pr.repo.name} #${pr.number}: ${parsePullRequestTitle(pr.title).text}`).join('\n'),
            confirmLabel: 'Merge'
        });
        if (!ok) return;
        setMerging(true);
        setMergeError(undefined);
        const errors: string[] = [];
        for (const pr of ready) {
            try {
                await window.shipwarden.github.merge(pr.repo, pr.number, pr.headSha!, pr.mergeMethod ?? 'merge');
            } catch (error) {
                errors.push(`${pr.repo.name} #${pr.number}: ${errorText(error)}`);
            }
        }
        setMergeError(errors.length ? errors.join('\n') : undefined);
        setMerging(false);
        await dashboardStore.refresh();
    };

    // The details of the counts at the top.
    const authorCounts = groupReviewRequests(reviewRequests, 'author');
    const oldestReview = groupReviewRequests(reviewRequests, 'oldest')[0]?.items[0];
    const reviewDetail = reviewRequests.length === 0
        ? 'Nothing waits on you'
        : [authorCounts[0] && authorCounts.length > 1 ? `${authorCounts[0].items.length} from ${authorCounts[0].key}` : `From ${authorCounts[0].key}`,
            oldestReview && `oldest ${shortAge(oldestReview.createdAt)}`].filter(Boolean).join(' · ');
    const ciCount = all.blocked.filter(pr => pr.reasons.includes('ci-failing')).length;
    const conflictCount = all.blocked.filter(pr => pr.reasons.includes('conflicts')).length;
    const oldestChange = all.changes[all.changes.length - 1];
    const loaded = !!pullRequests;
    const yourCount = pullRequests?.myPullRequests.length ?? 0;
    const shownYourCount = buckets.ready.length + buckets.changes.length + buckets.blocked.length + buckets.stale.length;
    const stalePreview = buckets.stale.slice(0, 4).map(pr => parsePullRequestTitle(pr.title).text);
    const oldestStale = buckets.stale[0];
    const commentsLoaded = !!state.prComments;
    const noComments = commentsLoaded && !state.prCommentsError && shownPrComments.length === 0 && shownTaskComments.length === 0
        && !state.tasks.some(source => source.error);
    // Show the full-page loader only before the first refresh completes.
    // The store keeps its items. Thus a later refresh or a new mount shows the items immediately.
    const firstLoad = !state.updatedAt && !state.pullRequestsError && !state.prCommentsError;

    return (
        <div className="dashboard-view">
            <header className="tasks-header dash-header">
                <div className="tasks-header-group where">
                    <LayoutDashboard size={16} strokeWidth={1.7} />
                    <h1>Dashboard</h1>
                    {state.updatedAt && <span className="dash-time">Updated {timeAgo(new Date(state.updatedAt).toISOString())}</span>}
                </div>
                <div className="tasks-header-group how">
                    <span className="header-spacer" />
                    <label className="tasks-search dash-filter">
                        <Search size={14} strokeWidth={1.6} />
                        <input
                            ref={filterInput}
                            value={query}
                            placeholder="Filter by title, ticket, repo…"
                            aria-label="Filter the Dashboard"
                            spellCheck={false}
                            onChange={event => setQuery(event.target.value)}
                            onKeyDown={event => {
                                if (event.key === 'Escape') {
                                    setQuery('');
                                    event.currentTarget.blur();
                                }
                            }}
                        />
                        {!query && <kbd className="dash-kbd">/</kbd>}
                    </label>
                    {hiddenCount > 0 && (
                        <button className="button dash-header-button" title="Show the hidden authors and rules" onClick={onOpenSettings}>
                            {hiddenCount} hiding rule{hiddenCount === 1 ? '' : 's'}
                        </button>
                    )}
                    <button className="icon-button" title="Dashboard settings" onClick={onOpenSettings}>
                        <Settings2 size={15} strokeWidth={1.6} />
                    </button>
                    <button className="icon-button" title="Refresh" onClick={() => void dashboardStore.refresh()}>
                        <RefreshCw size={15} strokeWidth={1.6} className={state.loading ? 'spin' : ''} />
                    </button>
                </div>
            </header>

            {firstLoad && (
                <div className="dash-first-load">
                    <SeaLoader hint="The first load can take some seconds." />
                </div>
            )}
            <div className="dash-scroll" hidden={firstLoad} onKeyDown={moveListFocus}>
                <div className="dash-page">
                    <div className="dash-stats">
                        <StatCard tone="review" label="Needs your review" count={pullRequests && reviewRequests.length} detail={loaded ? reviewDetail : 'Loading…'} onClick={() => scrollTo('dash-review')} />
                        <StatCard tone="ready" label="Ready to merge" count={pullRequests && all.ready.length} detail={all.ready.length ? 'One click each' : 'Nothing to merge'} onClick={() => scrollTo('dash-ready')} />
                        <StatCard tone="changes" label="Changes requested" count={pullRequests && all.changes.length} detail={oldestChange ? `Oldest ${shortAge(oldestChange.updatedAt)}` : 'No changes asked'} onClick={() => scrollTo('dash-changes')} />
                        <StatCard
                            tone="blocked"
                            label="Blocked"
                            count={pullRequests && all.blocked.length}
                            detail={all.blocked.length ? [ciCount && `${ciCount} CI failing`, conflictCount && `${conflictCount} conflict${conflictCount === 1 ? '' : 's'}`].filter(Boolean).join(' · ') : 'CI green, no conflicts'}
                            onClick={() => scrollTo('dash-blocked')}
                        />
                        <StatCard tone="stale" label={`Stale ${DASHBOARD_STALE_DAYS}d+`} count={pullRequests && all.stale.length} detail={all.stale.length ? 'Close or revive' : 'None'} onClick={() => scrollTo('dash-stale')} />
                    </div>

                    <div className="dash-columns">
                        <div className="dash-column">
                            <h2 className="dash-heading">Your pull requests · {query ? `${shownYourCount} of ${yourCount}` : yourCount}</h2>
                            {state.pullRequestsError && <div className="form-error">{state.pullRequestsError}</div>}
                            {!pullRequests && !state.pullRequestsError && <div className="dash-card dash-line">Loading…</div>}
                            {loaded && yourCount === 0 && <div className="dash-card"><Empty text="None of your pull requests needs an action." /></div>}
                            {loaded && yourCount > 0 && shownYourCount === 0 && <div className="dash-card"><Empty text="No pull requests match the filter." /></div>}

                            {buckets.ready.length > 0 && (
                                <PrCard
                                    id="dash-ready"
                                    tone="ready"
                                    title="Ready to merge"
                                    count={buckets.ready.length}
                                    hint="Approved, CI green, no conflicts"
                                    actions={buckets.ready.length > 1 && (
                                        <button className="button dash-merge" disabled={merging} onClick={() => void merge(buckets.ready)}>
                                            {buckets.ready.length === 2 ? 'Merge both' : `Merge all ${buckets.ready.length}`}
                                        </button>
                                    )}
                                >
                                    {mergeError && <div className="form-error dash-card-error">{mergeError}</div>}
                                    {buckets.ready.map(pr => (
                                        <PrRow
                                            key={pr.url}
                                            pr={pr}
                                            onOpen={() => openMine(pr)}
                                            action={(
                                                <button
                                                    className="button dash-merge dash-row-action"
                                                    disabled={merging || !pr.headSha}
                                                    title={pr.mergeMethod ? MERGE_LABELS[pr.mergeMethod] : undefined}
                                                    onClick={event => {
                                                        event.stopPropagation();
                                                        void merge([pr]);
                                                    }}
                                                >
                                                    Merge
                                                </button>
                                            )}
                                        />
                                    ))}
                                </PrCard>
                            )}

                            {buckets.changes.length > 0 && (
                                <PrCard id="dash-changes" tone="changes" title="Changes requested" count={buckets.changes.length} hint="Waiting on you, not the reviewer">
                                    {buckets.changes.map(pr => (
                                        <PrRow
                                            key={pr.url}
                                            pr={pr}
                                            onOpen={() => openMine(pr)}
                                            badges={(
                                                <>
                                                    {!!pr.unresolvedThreads && <span className="dash-unresolved">{pr.unresolvedThreads} unresolved</span>}
                                                    <ProblemBadges pr={pr} />
                                                </>
                                            )}
                                            action={(
                                                <button className="button dash-row-action" onClick={event => { event.stopPropagation(); onOpenPullRequest(pr.repo, pr.number, 'overview'); }}>
                                                    Open
                                                </button>
                                            )}
                                        />
                                    ))}
                                </PrCard>
                            )}

                            {buckets.blocked.length > 0 && (
                                <PrCard id="dash-blocked" tone="blocked" title="Blocked" count={buckets.blocked.length} hint={`CI failing or merge conflicts, under ${DASHBOARD_STALE_DAYS} days old`}>
                                    {buckets.blocked.map(pr => <PrRow key={pr.url} pr={pr} onOpen={() => openMine(pr)} badges={<ProblemBadges pr={pr} />} />)}
                                </PrCard>
                            )}

                            {buckets.stale.length > 0 && (
                                <section id="dash-stale" className={`dash-card dash-pr-card dash-stale${staleOpen ? ' open' : ''}`}>
                                    <button className="dash-card-head dash-stale-head" aria-expanded={staleOpen} onClick={() => setStaleOpen(open => !open)}>
                                        <ChevronRight size={14} strokeWidth={1.8} className={`group-chevron${staleOpen ? ' open' : ''}`} />
                                        <h3>Stale · {DASHBOARD_STALE_DAYS}+ days</h3>
                                        <span className="dash-card-count">{buckets.stale.length}</span>
                                        {oldestStale && <span className="dash-hint">Oldest {shortAge(oldestStale.updatedAt)}.</span>}
                                    </button>
                                    {staleOpen
                                        ? buckets.stale.map(pr => <PrRow key={pr.url} pr={pr} onOpen={() => openMine(pr)} badges={<ProblemBadges pr={pr} />} />)
                                        : (
                                            <div className="dash-stale-preview">
                                                {stalePreview.join(' · ')}
                                                {buckets.stale.length > stalePreview.length && ` · +${buckets.stale.length - stalePreview.length} more`}
                                            </div>
                                        )}
                                </section>
                            )}
                        </div>

                        <div className="dash-column">
                            <h2 className="dash-heading">Waiting on your review · {query ? `${shownReviews.length} of ${reviewRequests.length}` : reviewRequests.length}</h2>
                            <section id="dash-review" className="dash-card dash-review-card">
                                <div className="dash-chips" role="group" aria-label="Sort the review requests">
                                    {(Object.keys(REVIEW_SORT_LABELS) as ReviewSort[]).map(sort => (
                                        <button key={sort} className={`dash-chip${reviewSort === sort ? ' on' : ''}`} aria-pressed={reviewSort === sort} onClick={() => setReviewSort(sort)}>
                                            {REVIEW_SORT_LABELS[sort]}
                                        </button>
                                    ))}
                                </div>
                                {state.pullRequestsError && <div className="form-error">{state.pullRequestsError}</div>}
                                {!pullRequests && !state.pullRequestsError && <div className="panel-note">Loading…</div>}
                                {loaded && reviewRequests.length === 0 && <Empty text="No pull requests wait for your review." />}
                                {loaded && reviewRequests.length > 0 && shownReviews.length === 0 && <Empty text="No review requests match the filter." />}
                                {reviewGroups.map(group => (
                                    <div key={group.key || 'all'} className="dash-review-group">
                                        {group.key && (
                                            <div className="dash-review-group-head">
                                                {reviewSort === 'author' && <span className="dash-avatar">{group.key.charAt(0).toUpperCase()}</span>}
                                                <strong>{group.key}</strong>
                                                <span className="dash-card-count">{group.items.length}</span>
                                            </div>
                                        )}
                                        {group.items.map(pr => (
                                            <button key={pr.url} className={`dash-row dash-review-row${group.key ? ' indented' : ''}`} data-nav-item onClick={() => onOpenPullRequest(pr.repo, pr.number, 'files')}>
                                                <span className="dash-title" title={pr.title}>{parsePullRequestTitle(pr.title).text}</span>
                                                {reviewSort !== 'author' && <span className="dash-person">{pr.author ?? 'unknown'}</span>}
                                                <RepoPill repo={pr.repo} number={pr.number} />
                                                <Age iso={pr.createdAt} title={`Opened ${timeAgo(pr.createdAt)}`} />
                                            </button>
                                        ))}
                                    </div>
                                ))}
                            </section>

                            {!commentsLoaded && !state.prCommentsError && (
                                <div className="dash-card dash-line">Loading comments… The first load can take some seconds.</div>
                            )}
                            {noComments && (
                                <div className="dash-card dash-line">
                                    <CircleCheck size={15} strokeWidth={1.8} className="dash-ok" />
                                    {query
                                        ? 'No new comments match the filter.'
                                        : `No new ${state.tasks.length ? 'PR or task comments' : 'PR comments'} in the last ${DASHBOARD_WINDOW_DAYS} days.`}
                                </div>
                            )}

                            {(state.prCommentsError || shownPrComments.length > 0) && (
                                <CommentSection title="New pull request comments" count={unseenPr.length} onMarkAll={markAllPr}>
                                    {state.prCommentsError && <div className="form-error">{state.prCommentsError}</div>}
                                    {groupBy(shownPrComments, item => item.prUrl).map(([url, items]) => (
                                        <div key={url} className="dash-group">
                                            <button className="dash-row dash-group-head" data-nav-item onClick={() => onOpenPullRequest(items[0].repo, items[0].number, 'overview')}>
                                                <Title title={items[0].prTitle} empty="" />
                                                <RepoPill repo={items[0].repo} number={items[0].number} />
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
                                    {state.tasks.filter(source => source.error).map(source => (
                                        <div key={source.connectionId} className="form-error">{source.name}: {source.error}</div>
                                    ))}
                                    {groupBy(shownTaskComments, ({ source, comment }) => `${source.connectionId}\0${comment.taskId}`).map(([key, items]) => {
                                        const task: TaskCommentItem = items[0].comment;
                                        return (
                                            <div key={key} className="dash-group">
                                                <button className="dash-row dash-group-head" data-nav-item onClick={event => openUrl(task.taskUrl, event)} title="Open the task in the browser">
                                                    <Ticket ticket={task.taskKey} empty="" />
                                                    <span className="dash-title">{task.taskTitle}</span>
                                                    <span className="dash-repo">{items[0].source.name}</span>
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
        <section className="dash-card dash-comment-card">
            <header className="dash-card-head">
                <MessageSquare size={14} strokeWidth={1.7} />
                <h3>{title}</h3>
                <span className="dash-card-count">{count}</span>
                <span className="header-spacer" />
                {count > 0 && <button className="link-button" onClick={onMarkAll}><CheckCheck size={13} strokeWidth={1.8} /> Mark all as seen</button>}
            </header>
            {children}
        </section>
    );
}
