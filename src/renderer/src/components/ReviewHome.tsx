import { useMemo, useRef, useState } from 'react';
import { CircleCheck, CircleX, Clock, RefreshCw, Search } from 'lucide-react';
import { parseRepoId, repoId, repoLabel } from '@shared/github';
import { isWaiting, summarizeRepo, ageLevel, type QueueItem, type RepoReviewSummary } from '@shared/review-queue';
import { shortAge } from '@shared/dashboard';
import { timeAgo } from '../util';
import { focusFirstItem, moveListFocus } from '../keyboard/list-nav';
import { radioGroupKeys } from './keyboard';
import { refreshReviewOverview, useReviewOverview } from '../github/review-overview-store';
import { CountPill, Dotted, KeyLegend, useInitialFocus, usePageKeys } from './ReviewParts';

interface Props {
    queue: QueueItem[];
    /** The repository to focus first, for example the repository that the user came back from. */
    focusRepo?: string;
    onSelect(repo: string): void;
    onStartQueue(): void;
    onOpenSettings(): void;
}

/** "In projects" or "All". It stays for the session. */
let savedMode: 'projects' | 'all' | undefined;

interface WaitingRow {
    id: string;
    summary: RepoReviewSummary;
}

interface IdleRow {
    id: string;
    meta: string;
}

/** The name of a repository for the UI, from its ID. An Azure Repos repository shows as "organization/project/name". */
function label(id: string): string {
    return repoLabel(parseRepoId(id));
}

function matches(id: string, words: string[]): boolean {
    const text = id.toLowerCase();
    return words.every(word => text.includes(word));
}

function days(iso: string): number {
    return Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 86_400_000));
}

function RepoChecks({ summary }: { summary: RepoReviewSummary }) {
    const props = { size: 14, strokeWidth: 1.8 };
    if (summary.failing > 0)
        return (
            <span className="checks-label failing">
                <CircleX {...props} />
                {summary.failing} failing
            </span>
        );
    if (summary.running > 0)
        return (
            <span className="checks-label running">
                <Clock {...props} />
                Running
            </span>
        );
    if (summary.passing > 0)
        return (
            <span className="checks-label passing">
                <CircleCheck {...props} />
                Passing
            </span>
        );
    return <span className="count-pill-none">—</span>;
}

/**
 * The entry page of the Review view. The top part shows the repositories with pull requests that wait on the user.
 * The bottom part shows the other repositories: of the projects, or all repositories of the providers.
 */
export function ReviewHome({ queue, focusRepo, onSelect, onStartQueue, onOpenSettings }: Props) {
    const state = useReviewOverview();
    const [query, setQuery] = useState('');
    const [mode, setModeState] = useState<'projects' | 'all'>(savedMode ?? 'projects');
    const setMode = (value: 'projects' | 'all') => {
        savedMode = value;
        setModeState(value);
    };
    const rootRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const filterRef = useRef<HTMLInputElement>(null);

    const entries = Object.values(state.repos);
    const anyLoaded = entries.some(entry => entry.data);
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    /** Without project repositories, the page shows all repositories. */
    const all = mode === 'all' || state.projectRepos.length === 0;

    const waiting = useMemo<WaitingRow[]>(
        () =>
            Object.values(state.repos)
                .flatMap(entry => (entry.data ? [{ id: entry.id, summary: summarizeRepo(entry.data) }] : []))
                .filter(row => isWaiting(row.summary))
                .sort((a, b) => (a.summary.oldest ?? '').localeCompare(b.summary.oldest ?? '') || a.id.localeCompare(b.id)),
        [state.repos]
    );

    const idle = useMemo<IdleRow[]>(() => {
        const busy = new Set(waiting.map(row => row.id.toLowerCase()));
        const ids = all ? (state.catalog ?? []).map(repoId) : state.projectRepos;
        const pushed = new Map((state.catalog ?? []).map(repo => [repoId(repo).toLowerCase(), repo.pushedAt]));
        return ids
            .filter(id => !busy.has(id.toLowerCase()))
            .map(id => {
                const entry = state.repos[id.toLowerCase()];
                if (entry?.data) {
                    const summary = summarizeRepo(entry.data);
                    const count = summary.openCount;
                    const open = count === 0 ? 'No open PRs' : `${count} open PR${count === 1 ? '' : 's'}`;
                    return { id: entry.id, meta: count > 0 && summary.lastActivity ? `${open} · last activity ${timeAgo(summary.lastActivity)}` : open };
                }
                if (entry?.error) return { id, meta: 'Could not load the pull requests' };
                const push = pushed.get(id.toLowerCase());
                return { id, meta: push ? `Last push ${timeAgo(push)}` : entry?.loading ? 'Loading…' : '' };
            });
    }, [all, state.catalog, state.projectRepos, state.repos, waiting]);

    const shownWaiting = waiting.filter(row => matches(row.id, words));
    const shownIdle = idle.filter(row => matches(row.id, words));
    const reviewRepos = waiting.filter(row => row.summary.toReview + row.summary.reReview > 0);
    const oldest = queue[0]?.createdAt;
    const yourPrs = waiting.reduce((sum, row) => sum + row.summary.yourPrs, 0);
    const first = shownWaiting[0]?.id ?? shownIdle[0]?.id;

    usePageKeys(rootRef, listRef, {
        '/': () => filterRef.current?.focus(),
        r: () => queue.length > 0 && onStartQueue()
    });
    useInitialFocus(listRef, focusRepo ? `[data-repo="${CSS.escape(focusRepo.toLowerCase())}"]` : undefined, anyLoaded || !!state.catalog);

    const title =
        !anyLoaded && !state.catalog
            ? 'Loading pull requests…'
            : queue.length === 0
              ? 'Nothing waiting on your review'
              : `${queue.length} pull request${queue.length === 1 ? '' : 's'} waiting on you`;
    const subtitle = (
        <Dotted
            parts={[
                queue.length > 0 && `across ${reviewRepos.length} ${reviewRepos.length === 1 ? 'repository' : 'repositories'}`,
                oldest && `oldest waiting ${days(oldest)} ${days(oldest) === 1 ? 'day' : 'days'}`,
                yourPrs > 0 && `${yourPrs} of your PRs need${yourPrs === 1 ? 's' : ''} action`
            ]}
        />
    );

    return (
        <div className="review-home" ref={rootRef}>
            <header className="tasks-header review-header">
                <div className="tasks-header-group how">
                    <label className="tasks-search review-repo-filter">
                        <Search size={14} strokeWidth={1.6} />
                        <input
                            ref={filterRef}
                            value={query}
                            placeholder="Filter repositories"
                            aria-label="Filter repositories"
                            spellCheck={false}
                            onChange={event => setQuery(event.target.value)}
                            onKeyDown={event => {
                                if (event.key === 'Enter' && first) onSelect(first);
                                if (event.key === 'ArrowDown' && focusFirstItem(listRef.current)) event.preventDefault();
                                if (event.key === 'Escape') {
                                    event.preventDefault();
                                    setQuery('');
                                    event.currentTarget.blur();
                                    focusFirstItem(listRef.current);
                                }
                            }}
                        />
                        {!query && <kbd className="field-key">/</kbd>}
                    </label>
                    {state.projectRepos.length > 0 && (
                        <div className="segmented compact" role="radiogroup" aria-label="Repositories" onKeyDown={radioGroupKeys}>
                            <button
                                role="radio"
                                aria-checked={!all}
                                tabIndex={!all ? 0 : -1}
                                className={!all ? 'selected' : ''}
                                onClick={() => setMode('projects')}
                            >
                                In projects
                            </button>
                            <button role="radio" aria-checked={all} tabIndex={all ? 0 : -1} className={all ? 'selected' : ''} onClick={() => setMode('all')}>
                                All
                            </button>
                        </div>
                    )}
                    <span className="header-spacer" />
                    <button className="icon-button" title="Refresh" onClick={() => void refreshReviewOverview()}>
                        <RefreshCw size={15} strokeWidth={1.6} className={state.catalogLoading || entries.some(entry => entry.loading) ? 'spin' : ''} />
                    </button>
                    <button className="button primary-solid review-queue-button" disabled={queue.length === 0} onClick={onStartQueue}>
                        Start review queue
                        {queue.length > 0 && <span className="button-count">{queue.length}</span>}
                    </button>
                </div>
            </header>

            <div className="review-home-body" ref={listRef} onKeyDown={moveListFocus}>
                <div className="review-home-title">
                    <h2>{title}</h2>
                    <span className="review-home-subtitle">{subtitle}</span>
                </div>
                {state.catalogError && <div className="form-error task-list-error">{state.catalogError}</div>}
                {state.catalog?.length === 0 && (
                    <div className="review-empty">
                        <p>The selected organizations have no repositories that you can access.</p>
                        <button className="button" onClick={onOpenSettings}>
                            Open Settings › Code review
                        </button>
                    </div>
                )}

                {shownWaiting.length > 0 && (
                    <section aria-label="Waiting on you">
                        <div className="review-grid review-grid-head" aria-hidden="true">
                            <span>Waiting on you</span>
                            <span>To review</span>
                            <span>Re-review</span>
                            <span>Your PRs</span>
                            <span>Oldest</span>
                            <span>Checks</span>
                        </div>
                        {shownWaiting.map(({ id, summary }) => (
                            <button
                                key={id}
                                className="review-grid review-repo-row"
                                data-nav-item
                                data-repo={id.toLowerCase()}
                                aria-label={`${label(id)}: ${summary.toReview} to review, ${summary.reReview} to review again, ${summary.yourPrs} of your pull requests`}
                                onClick={() => onSelect(id)}
                            >
                                <span className="review-repo-name">
                                    <strong>{label(id)}</strong>
                                    <span className="review-repo-meta">
                                        <Dotted
                                            parts={[
                                                summary.lastActivity && `Last activity ${timeAgo(summary.lastActivity)}`,
                                                `${summary.openCount} open PR${summary.openCount === 1 ? '' : 's'}`
                                            ]}
                                        />
                                    </span>
                                </span>
                                <span>
                                    <CountPill value={summary.toReview} tone="info" />
                                </span>
                                <span>
                                    <CountPill value={summary.reReview} tone="accent" />
                                </span>
                                <span>
                                    <CountPill value={summary.yourPrs} tone="plain" />
                                </span>
                                <span className={`review-age ${summary.oldest ? ageLevel(summary.oldest) : ''}`}>
                                    {summary.oldest ? shortAge(summary.oldest) : '—'}
                                </span>
                                <span>
                                    <RepoChecks summary={summary} />
                                </span>
                            </button>
                        ))}
                    </section>
                )}

                {shownIdle.length > 0 && (
                    <section aria-label="Nothing waiting">
                        <h3 className="review-section-title">Nothing waiting · {shownIdle.length}</h3>
                        {shownIdle.map(row => (
                            <button key={row.id} className="review-idle-row" data-nav-item data-repo={row.id.toLowerCase()} onClick={() => onSelect(row.id)}>
                                <span className="review-idle-name">{label(row.id)}</span>
                                <span className="review-idle-meta">{row.meta}</span>
                            </button>
                        ))}
                    </section>
                )}

                {anyLoaded && shownWaiting.length === 0 && shownIdle.length === 0 && <div className="panel-message">No repositories match the filter.</div>}
                {!all && state.catalog && (
                    <div className="review-show-all-row">
                        <button className="button review-show-all" onClick={() => setMode('all')}>
                            Show all repositories ({state.catalog.length})
                        </button>
                    </div>
                )}
            </div>

            <KeyLegend
                items={[
                    { keys: ['j', 'k'], label: 'move' },
                    { keys: ['↵'], label: 'open' },
                    { keys: ['/'], label: 'filter' },
                    { keys: ['r'], label: 'start review queue' }
                ]}
            />
        </div>
    );
}
