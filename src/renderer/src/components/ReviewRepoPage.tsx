import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, GitMerge, GitPullRequest, GitPullRequestDraft, RefreshCw, Search } from 'lucide-react';
import { parseRepoId, repoLabel, type PullRequestSummary, type RepoRef } from '@shared/github';
import { MY_PULL_REQUEST_REASON_LABELS, parsePullRequestTitle, shortAge } from '@shared/dashboard';
import {
    PULL_REQUEST_SORTS,
    ageLevel,
    diffSize,
    hasUnseenActivity,
    matchesSearch,
    reviewActivitySeenKey,
    reviewGroup,
    sortPullRequests,
    type OpenPullRequest,
    type PullRequestSort,
    type ReviewGroup
} from '@shared/review-queue';
import { optionalErrorText, timeAgo } from '../util';
import { focusFirstItem, itemKeys, moveListFocus } from '../keyboard/list-nav';
import { seenStore, useIsSeen } from '../seen-store';
import { overviewKeys, refreshRepo, useRepoEntry } from '../github/review-overview-store';
import { Combobox, type ComboboxGroup } from './Combobox';
import { ChecksLabel, Dotted, KeyLegend, focusedData, useInitialFocus, usePageKeys } from './ReviewParts';
import { InlineTip } from './Tips';

export type RepoTab = 'needs' | 'mine' | 'open' | 'merged';

const SORT_KEY = 'shipwarden.reviewSort';

function readSort(): PullRequestSort {
    try {
        const value = localStorage.getItem(SORT_KEY);
        return PULL_REQUEST_SORTS.some(item => item.id === value) ? (value as PullRequestSort) : 'waiting';
    } catch {
        return 'waiting';
    }
}

function writeSort(value: PullRequestSort): void {
    try {
        localStorage.setItem(SORT_KEY, value);
    } catch {
        // The choice stays for this session only.
    }
}

interface Props {
    /** "owner/name". */
    repo: string;
    repoRef: RepoRef;
    /** The repositories for the picker. */
    groups: ComboboxGroup[];
    /** The pull request to focus first, for example the pull request that the user came back from. */
    focusNumber?: number;
    hidden: boolean;
    onSelectRepo(repo: string): void;
    onBack(): void;
    onOpen(number: number): void;
    /** Opens the New worktree dialog on the head branch. Without it, the key does nothing. */
    onCheckout?(pr: { headRefName: string }): void;
    /** Opens the pull request and starts an agent review. */
    onHandToAgent(number: number): void;
}

/** The text of the last review of the viewer. */
const REVIEW_TEXT: Record<string, string> = {
    APPROVED: 'You approved',
    CHANGES_REQUESTED: 'You requested changes',
    COMMENTED: 'You commented',
    DISMISSED: 'Your review was dismissed'
};

function PrIcon({ pr, group }: { pr: OpenPullRequest; group: ReviewGroup }) {
    const props = { size: 15, strokeWidth: 1.7 };
    if (pr.isDraft) return <GitPullRequestDraft {...props} className="pr-row-icon draft" />;
    return <GitPullRequest {...props} className={`pr-row-icon ${group}`} />;
}

function TitleLine({ title }: { title: string }) {
    const parsed = parsePullRequestTitle(title);
    return (
        <span className="pr-row-title">
            {parsed.ticket && <span className="ticket-chip">{parsed.ticket}</span>}
            <span className="pr-row-title-text">{parsed.ticket ? parsed.text : title}</span>
        </span>
    );
}

function SinceReviewLine({ pr }: { pr: OpenPullRequest }) {
    const review = pr.viewerReview;
    if (!review) return null;
    const since = pr.sinceReview;
    const commits = since?.newCommits;
    const changed = !!review.commitOid && review.commitOid !== pr.headRefOid;
    const newComments = !!pr.lastActivityAt && Date.parse(pr.lastActivityAt) > Date.parse(review.submittedAt);
    return (
        <span className="pr-row-meta">
            <span className={`pr-review-state ${review.state.toLowerCase()}`}>
                {REVIEW_TEXT[review.state] ?? 'You reviewed'} {timeAgo(review.submittedAt)}
            </span>
            {' · '}
            <Dotted
                parts={[
                    commits ? `${commits} new commit${commits === 1 ? '' : 's'}` : changed ? 'New commits' : 'No new commits',
                    newComments && `new comments ${timeAgo(pr.lastActivityAt!)}`,
                    since && since.threads > 0 && `${since.resolved} of ${since.threads} of your threads resolved`
                ]}
            />
        </span>
    );
}

/**
 * A row of an open pull request. A row is not a button, because it can have a button in it.
 * `onMarkSeen` shows the "Mark as seen" button. The row gets it when the activity after the review of the user shows the pull request.
 */
function PrRow({ pr, group, onOpen, onMarkSeen }: { pr: OpenPullRequest; group: ReviewGroup; onOpen(): void; onMarkSeen?(): void }) {
    const size = diffSize(pr.additions, pr.deletions);
    const waitingSince = pr.createdAt;
    return (
        <div className="pr-row" role="button" tabIndex={0} data-nav-item data-pr={pr.number} onClick={onOpen} onKeyDown={itemKeys(onOpen)}>
            <PrIcon pr={pr} group={group} />
            <span className="pr-row-main">
                <TitleLine title={pr.title} />
                <span className="pr-row-meta">
                    <Dotted
                        parts={[
                            `#${pr.number}`,
                            pr.author ?? 'unknown',
                            <span key="branch">
                                {pr.headRefName} → {pr.baseRefName}
                            </span>,
                            pr.isDraft && 'draft',
                            `opened ${timeAgo(pr.createdAt)}`,
                            pr.updatedAt !== pr.createdAt && `updated ${timeAgo(pr.updatedAt)}`
                        ]}
                    />
                </span>
                {group === 're-review' && (
                    <span className="pr-row-since">
                        <SinceReviewLine pr={pr} />
                        {onMarkSeen && (
                            <button
                                className="link-button pr-row-seen"
                                title="Remove the pull request from your review list. It shows again after a new commit or comment."
                                onClick={event => {
                                    event.stopPropagation();
                                    onMarkSeen();
                                }}
                            >
                                <Check size={12} strokeWidth={2} /> Mark as seen
                            </button>
                        )}
                    </span>
                )}
                {pr.viewerDidAuthor && pr.actions.length > 0 && (
                    <span className="pr-row-meta">
                        {pr.actions.map(reason => (
                            <span key={reason} className={`pr-action ${reason}`}>
                                {MY_PULL_REQUEST_REASON_LABELS[reason]}
                            </span>
                        ))}
                    </span>
                )}
            </span>
            <span className="pr-row-checks">
                <ChecksLabel checks={pr.checks} />
            </span>
            <span className="pr-row-size">
                <span>
                    <span className="additions">+{pr.additions}</span> <span className="deletions">−{pr.deletions}</span>
                    {' · '}
                    {pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}
                </span>
                <span className="diff-bar">
                    <span className={size.size} style={{ width: `${Math.round(size.fill * 100)}%` }} />
                </span>
            </span>
            <span className="pr-row-comments">{pr.comments} cmt</span>
            <span className={`review-age ${ageLevel(waitingSince)}`} title={`Opened ${new Date(waitingSince).toLocaleString()}`}>
                {shortAge(waitingSince)}
            </span>
        </div>
    );
}

function MergedRow({ pr, onOpen }: { pr: PullRequestSummary; onOpen(): void }) {
    return (
        <button className="pr-row" data-nav-item data-pr={pr.number} onClick={onOpen}>
            <GitMerge size={15} strokeWidth={1.7} className="pr-row-icon merged" />
            <span className="pr-row-main">
                <TitleLine title={pr.title} />
                <span className="pr-row-meta">
                    <Dotted parts={[`#${pr.number}`, pr.author ?? 'unknown', `merged ${timeAgo(pr.updatedAt)}`]} />
                </span>
            </span>
            <span />
            <span className="pr-row-size">
                <span>
                    <span className="additions">+{pr.additions}</span> <span className="deletions">−{pr.deletions}</span>
                </span>
            </span>
            <span className="pr-row-comments">{pr.comments} cmt</span>
            <span />
        </button>
    );
}

/** The tab that the page shows first. It stays for the session, for each repository. */
const savedTabs = new Map<string, RepoTab>();

/**
 * The list page of the Review view: the open pull requests of one repository.
 * The "Needs me" tab splits the pull requests into new reviews and reviews to do again.
 * The data comes from the review overview store, so the page shows at once. The merged list loads on request.
 */
export function ReviewRepoPage({ repo, repoRef, groups, focusNumber, hidden, onSelectRepo, onBack, onOpen, onCheckout, onHandToAgent }: Props) {
    const entry = useRepoEntry(repo);
    const data = entry?.data;
    const [query, setQuery] = useState('');
    const [sort, setSortState] = useState<PullRequestSort>(readSort);
    const [showWaiting, setShowWaiting] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);

    const isSeen = useIsSeen();
    const prs = useMemo(() => (data?.pullRequests ?? []).filter(pr => matchesSearch(pr, query)), [data, query]);
    const byGroup = useMemo(() => {
        const result: Record<ReviewGroup, OpenPullRequest[]> = { new: [], 're-review': [], waiting: [], mine: [], other: [] };
        for (const pr of sortPullRequests(prs, sort)) result[reviewGroup(pr, isSeen)].push(pr);
        return result;
    }, [prs, sort, isSeen]);
    const sorted = useMemo(() => sortPullRequests(prs, sort), [prs, sort]);
    const needsCount = byGroup.new.length + byGroup['re-review'].length;

    const [tab, setTabState] = useState<RepoTab | undefined>(() => savedTabs.get(repo.toLowerCase()));
    // Without a saved tab, the page starts on "Needs me" when something needs the user, and on "All open" when not.
    const current: RepoTab = tab ?? (data && needsCount === 0 && byGroup.waiting.length === 0 ? 'open' : 'needs');
    const setTab = (value: RepoTab) => {
        savedTabs.set(repo.toLowerCase(), value);
        setTabState(value);
    };
    useEffect(() => {
        setTabState(savedTabs.get(repo.toLowerCase()));
        setQuery('');
        setShowWaiting(false);
    }, [repo]);

    // The merged list comes from a GitHub search. It loads when the tab shows, after a short pause in typing.
    const [mergedQuery, setMergedQuery] = useState('');
    useEffect(() => {
        const timer = setTimeout(() => setMergedQuery(query.trim()), query ? 350 : 0);
        return () => clearTimeout(timer);
    }, [query]);
    const mergedResult = useQuery({
        queryKey: overviewKeys.merged(repo, mergedQuery),
        queryFn: (): Promise<PullRequestSummary[]> => window.shipwarden.github.pullRequests(repoRef, 'merged', mergedQuery),
        enabled: current === 'merged',
        // The last list stays while the list of a new search text loads.
        placeholderData: keepPreviousData
    });
    const merged = mergedResult.data;
    const mergedError = optionalErrorText(mergedResult.error);

    const setSort = (value: PullRequestSort) => {
        setSortState(value);
        writeSort(value);
    };

    const focusedPr = () => {
        const value = focusedData('pr');
        return value ? data?.pullRequests.find(pr => pr.number === Number(value)) : undefined;
    };
    usePageKeys(
        rootRef,
        listRef,
        {
            '/': () => searchRef.current?.focus(),
            Escape: onBack,
            c: () => {
                const pr = focusedPr();
                if (pr && onCheckout) onCheckout(pr);
            },
            a: () => {
                const pr = focusedPr();
                if (pr) onHandToAgent(pr.number);
            }
        },
        !hidden
    );
    useInitialFocus(listRef, focusNumber ? `[data-pr="${focusNumber}"]` : undefined, !!data && !hidden);

    const tabs: { id: RepoTab; label: string; count?: number }[] = [
        { id: 'needs', label: 'Needs me', count: needsCount },
        { id: 'mine', label: 'Mine', count: byGroup.mine.length },
        { id: 'open', label: 'All open', count: data ? (query ? prs.length : data.openCount) : undefined },
        { id: 'merged', label: 'Recently merged' }
    ];

    const rows = (list: OpenPullRequest[]) =>
        list.map(pr => {
            const group = reviewGroup(pr, isSeen);
            // A request from GitHub stays until the user reviews. Only the activity after a review can be marked as seen.
            const seenable = group === 're-review' && !pr.reviewRequested && hasUnseenActivity(pr, isSeen);
            return (
                <PrRow
                    key={pr.number}
                    pr={pr}
                    group={group}
                    onOpen={() => onOpen(pr.number)}
                    onMarkSeen={seenable ? () => seenStore.mark([reviewActivitySeenKey(pr)]) : undefined}
                />
            );
        });
    const section = (title: string, list: OpenPullRequest[]) =>
        list.length > 0 && (
            <section aria-label={title}>
                <h3 className="review-section-title">
                    {title} · {list.length}
                </h3>
                {rows(list)}
            </section>
        );

    return (
        <div className="review-repo-page" ref={rootRef} hidden={hidden}>
            <header className="tasks-header review-header">
                <div className="tasks-header-group where">
                    <button className="icon-button" title="All repositories (Esc)" onClick={onBack}>
                        <ArrowLeft size={15} strokeWidth={1.7} />
                    </button>
                    <Combobox
                        className="review-repo-select"
                        value={repo}
                        groups={groups}
                        placeholder={repoLabel(parseRepoId(repo))}
                        searchPlaceholder="Search repositories"
                        title="Repository"
                        onChange={onSelectRepo}
                    />
                </div>
                <div className="tasks-header-group how">
                    <label className="tasks-search review-pr-search">
                        <Search size={14} strokeWidth={1.6} />
                        <input
                            ref={searchRef}
                            value={query}
                            placeholder="Search title, #, author, ENG-…"
                            aria-label="Search pull requests"
                            spellCheck={false}
                            onChange={event => setQuery(event.target.value)}
                            onKeyDown={event => {
                                if (event.key === 'ArrowDown' && focusFirstItem(listRef.current)) event.preventDefault();
                                if (event.key === 'Escape') {
                                    event.preventDefault();
                                    setQuery('');
                                    event.currentTarget.blur();
                                    focusFirstItem(listRef.current);
                                }
                            }}
                        />
                    </label>
                    <span className="header-spacer" />
                    <button className="icon-button" title="Refresh" onClick={() => void refreshRepo(repo)}>
                        <RefreshCw size={15} strokeWidth={1.6} className={entry?.loading ? 'spin' : ''} />
                    </button>
                    <select
                        className="tasks-select"
                        value={sort}
                        title="Sort"
                        aria-label="Sort"
                        onChange={event => setSort(event.target.value as PullRequestSort)}
                    >
                        {PULL_REQUEST_SORTS.map(item => (
                            <option key={item.id} value={item.id}>
                                Sort: {item.label}
                            </option>
                        ))}
                    </select>
                </div>
            </header>

            <div className="review-tabs" role="tablist" aria-label="Pull requests">
                {tabs.map(item => (
                    <button
                        key={item.id}
                        role="tab"
                        aria-selected={current === item.id}
                        className={current === item.id ? 'selected' : ''}
                        onClick={() => setTab(item.id)}
                    >
                        {item.label}
                        {item.count !== undefined && <span className={`tab-count${item.id === 'needs' && item.count > 0 ? ' info' : ''}`}>{item.count}</span>}
                    </button>
                ))}
            </div>

            <div className="review-list" ref={listRef} onKeyDown={moveListFocus}>
                <InlineTip id="review" inset />
                {entry?.error && <div className="form-error task-list-error">{entry.error}</div>}
                {!data && !entry?.error && current !== 'merged' && <div className="panel-message">Loading pull requests…</div>}

                {data && current === 'needs' && (
                    <>
                        {section('New to you', byGroup.new)}
                        {section('Re-review · updated since your review', byGroup['re-review'])}
                        {needsCount === 0 && (
                            <div className="panel-message">
                                {query ? 'No pull requests match the search.' : 'Nothing in this repository needs your review.'}
                            </div>
                        )}
                        {byGroup.waiting.length > 0 &&
                            (showWaiting ? (
                                section('Waiting on authors', byGroup.waiting)
                            ) : (
                                <p className="review-waiting-note">
                                    Waiting on authors: {byGroup.waiting.length} PR{byGroup.waiting.length === 1 ? '' : 's'} you reviewed with no new activity,
                                    or with activity that you marked as seen ·{' '}
                                    <button className="link-button" onClick={() => setShowWaiting(true)}>
                                        show
                                    </button>
                                </p>
                            ))}
                    </>
                )}
                {data &&
                    current === 'mine' &&
                    (byGroup.mine.length ? (
                        rows(byGroup.mine)
                    ) : (
                        <div className="panel-message">
                            {query ? 'No pull requests match the search.' : 'You have no open pull requests in this repository.'}
                        </div>
                    ))}
                {data &&
                    current === 'open' &&
                    (sorted.length ? (
                        rows(sorted)
                    ) : (
                        <div className="panel-message">{query ? 'No pull requests match the search.' : 'No open pull requests.'}</div>
                    ))}
                {data && current === 'open' && data.openCount > data.pullRequests.length && !query && (
                    <p className="review-waiting-note">
                        The list shows the {data.pullRequests.length} most recently updated of {data.openCount} open pull requests.
                    </p>
                )}
                {current === 'merged' && (
                    <>
                        {mergedError && <div className="form-error task-list-error">{mergedError}</div>}
                        {!merged && !mergedError && <div className="panel-message">Loading pull requests…</div>}
                        {merged?.length === 0 && <div className="panel-message">No merged pull requests.</div>}
                        {merged?.map(pr => (
                            <MergedRow key={pr.number} pr={pr} onOpen={() => onOpen(pr.number)} />
                        ))}
                    </>
                )}
            </div>

            <KeyLegend
                items={[
                    { keys: ['j', 'k'], label: 'move' },
                    { keys: ['↵'], label: 'open' },
                    ...(onCheckout ? [{ keys: ['c'], label: 'checkout worktree' }] : []),
                    { keys: ['a'], label: 'hand to agent' },
                    { keys: ['esc'], label: 'back' }
                ]}
            />
        </div>
    );
}
