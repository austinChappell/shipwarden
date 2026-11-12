import { useMemo, useRef, useState } from 'react';
import { CircleCheck, CircleX, Clock, FolderGit2, GitPullRequest, Plus, RefreshCw } from 'lucide-react';
import { parseRepoId, repoId, repoLabel } from '@shared/github';
import { isWaiting, summarizeRepo, type QueueItem, type RepoReviewSummary } from '@shared/review-queue';
import { formatAgo, pluralize } from '@shared/format';
import { useIsSeen } from '../seen-store';
import { timeAgo } from '../util';
import { focusFirstItem, moveListFocus } from '../keyboard/list-nav';
import { radioGroupKeys } from './keyboard';
import { refreshReviewOverview, useReviewOverview } from '../github/review-overview-store';
import { useGroups } from '../github/pr-group-store';
import { groupSize, type PrGroup } from '@shared/pr-groups';
import { CountPill, Dotted, KeyLegend, useInitialFocus, usePageKeys } from './ReviewParts';
import { EmptyState } from './EmptyState';
import { Age, Button, ButtonGroup, Count, FilterField, IconButton, PageHeader, SkeletonRows } from './ui';

interface Props {
    queue: QueueItem[];
    /** The repository to focus first, for example the repository that the user came back from. */
    focusRepo?: string;
    onSelect(repo: string): void;
    onStartQueue(): void;
    onOpenSettings(): void;
    /** Opens the page of a PR group. */
    onOpenGroup(id: string): void;
    /** Makes a new PR group and opens its page. */
    onNewGroup(): void;
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

/** Returns "3 PRs in 2 repositories · reviewed 2h ago". */
function groupMeta(group: PrGroup): string {
    const size = groupSize(group);
    return group.lastReview ? `${size} · reviewed ${formatAgo(new Date(group.lastReview.at).toISOString())}` : size;
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
export function ReviewHome({ queue, focusRepo, onSelect, onStartQueue, onOpenSettings, onOpenGroup, onNewGroup }: Props) {
    const { groups } = useGroups();
    const state = useReviewOverview();
    const [query, setQuery] = useState('');
    const [mode, setModeState] = useState<'projects' | 'all'>(savedMode ?? 'projects');
    const setMode = (value: 'projects' | 'all') => {
        savedMode = value;
        setModeState(value);
    };
    const rootRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const entries = Object.values(state.repos);
    const anyLoaded = entries.some(entry => entry.data);
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    /** Without project repositories, the page shows all repositories. */
    const all = mode === 'all' || state.projectRepos.length === 0;

    const isSeen = useIsSeen();
    const waiting = useMemo<WaitingRow[]>(
        () =>
            Object.values(state.repos)
                .flatMap(entry => (entry.data ? [{ id: entry.id, summary: summarizeRepo(entry.data, isSeen) }] : []))
                .filter(row => isWaiting(row.summary))
                .sort((a, b) => (a.summary.oldest ?? '').localeCompare(b.summary.oldest ?? '') || a.id.localeCompare(b.id)),
        [state.repos, isSeen]
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
                    const summary = summarizeRepo(entry.data, isSeen);
                    const count = summary.openCount;
                    const open = count === 0 ? 'No open PRs' : pluralize(count, 'open PR');
                    return { id: entry.id, meta: count > 0 && summary.lastActivity ? `${open} · last activity ${timeAgo(summary.lastActivity)}` : open };
                }
                if (entry?.error) return { id, meta: 'Could not load the pull requests' };
                const push = pushed.get(id.toLowerCase());
                return { id, meta: push ? `Last push ${timeAgo(push)}` : entry?.loading ? 'Loading…' : '' };
            });
    }, [all, state.catalog, state.projectRepos, state.repos, waiting, isSeen]);

    const shownGroups = groups.filter(group => matches(group.name, words));
    const shownWaiting = waiting.filter(row => matches(row.id, words));
    const shownIdle = idle.filter(row => matches(row.id, words));
    const reviewRepos = waiting.filter(row => row.summary.toReview + row.summary.reReview > 0);
    const oldest = queue[0]?.createdAt;
    const yourPrs = waiting.reduce((sum, row) => sum + row.summary.yourPrs, 0);
    const first = shownWaiting[0]?.id ?? shownIdle[0]?.id;

    usePageKeys(rootRef, listRef, {
        r: () => queue.length > 0 && onStartQueue()
    });
    useInitialFocus(listRef, focusRepo ? `[data-repo="${CSS.escape(focusRepo.toLowerCase())}"]` : undefined, anyLoaded || !!state.catalog);

    const loading = !anyLoaded && !state.catalog;
    const reviewRepoText = pluralize(reviewRepos.length, 'repository', 'repositories');
    // The meta line of the header replaces the headline of the body (docs/design, finding 08).
    const meta = loading ? (
        'Loading pull requests…'
    ) : (
        <span title={queue.length > 0 ? `${pluralize(queue.length, 'pull request')} in ${reviewRepoText} wait for your review` : undefined}>
            <Dotted
                parts={[
                    queue.length === 0 ? 'Nothing waiting on you' : `${queue.length} waiting on you`,
                    oldest && `oldest ${formatAgo(oldest)}`,
                    yourPrs > 0 && `${yourPrs} of yours need${yourPrs === 1 ? 's' : ''} action`
                ]}
            />
        </span>
    );

    return (
        <div className="review-home" ref={rootRef}>
            <PageHeader
                icon={GitPullRequest}
                title="Review"
                meta={meta}
                scope={
                    state.projectRepos.length > 0 && (
                        <ButtonGroup role="radiogroup" label="Repositories" onKeyDown={radioGroupKeys}>
                            <Button role="radio" aria-checked={!all} tabIndex={!all ? 0 : -1} onClick={() => setMode('projects')}>
                                In projects
                            </Button>
                            <Button role="radio" aria-checked={all} tabIndex={all ? 0 : -1} onClick={() => setMode('all')}>
                                All
                            </Button>
                        </ButtonGroup>
                    )
                }
                filter={
                    <FilterField
                        value={query}
                        placeholder="Filter repositories"
                        onChange={setQuery}
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
                }
                actions={
                    <IconButton
                        size="lg"
                        icon={<RefreshCw size={16} strokeWidth={1.6} className={state.catalogLoading || entries.some(entry => entry.loading) ? 'spin' : ''} />}
                        label="Refresh"
                        onClick={() => void refreshReviewOverview()}
                    />
                }
                primary={
                    <Button variant="primary" size="lg" className="review-queue-button" disabled={queue.length === 0} onClick={onStartQueue}>
                        Start review queue
                        {queue.length > 0 && <Count value={queue.length} tone="on-primary" />}
                    </Button>
                }
            />

            <div className="review-home-body" ref={listRef} onKeyDown={moveListFocus}>
                {state.catalogError && <div className="form-error task-list-error">{state.catalogError}</div>}
                {loading && !state.catalogError && <SkeletonRows label="Loading pull requests" />}
                {state.catalog?.length === 0 && (
                    <EmptyState
                        icon={FolderGit2}
                        title="No repositories"
                        actions={
                            <Button size="lg" onClick={onOpenSettings}>
                                Open Settings › Code review
                            </Button>
                        }
                    >
                        The selected organizations have no repositories that you can access.
                    </EmptyState>
                )}

                {(shownGroups.length > 0 || words.length === 0) && (
                    <section aria-label="PR groups">
                        <h3 className="review-section-title">
                            PR groups <Count value={shownGroups.length} />
                            <span className="header-spacer" />
                            <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={onNewGroup}>
                                New group
                            </Button>
                        </h3>
                        {shownGroups.length === 0 && (
                            <p className="review-waiting-note">
                                Put pull requests that belong together in a group. An agent then reviews them together, also across repositories.
                            </p>
                        )}
                        {shownGroups.map(group => (
                            <button key={group.id} className="review-idle-row" data-nav-item onClick={() => onOpenGroup(group.id)}>
                                <span className="review-idle-name">{group.name}</span>
                                <span className="review-idle-meta">{groupMeta(group)}</span>
                            </button>
                        ))}
                    </section>
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
                                                pluralize(summary.openCount, 'open PR')
                                            ]}
                                        />
                                    </span>
                                </span>
                                <span>
                                    <CountPill value={summary.toReview} tone="accent" />
                                </span>
                                <span>
                                    <CountPill value={summary.reReview} />
                                </span>
                                <span>
                                    <CountPill value={summary.yourPrs} />
                                </span>
                                <span>{summary.oldest ? <Age date={summary.oldest} /> : <span className="count-pill-none">—</span>}</span>
                                <span>
                                    <RepoChecks summary={summary} />
                                </span>
                            </button>
                        ))}
                    </section>
                )}

                {shownIdle.length > 0 && (
                    <section aria-label="Nothing waiting">
                        <h3 className="review-section-title">
                            Nothing waiting <Count value={shownIdle.length} />
                        </h3>
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
                        <Button onClick={() => setMode('all')}>
                            Show all repositories <Count value={state.catalog.length} />
                        </Button>
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
