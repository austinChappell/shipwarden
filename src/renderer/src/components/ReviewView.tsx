import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowLeft,
    CircleCheck,
    CircleDot,
    CircleX,
    GitPullRequest,
    GitPullRequestClosed,
    GitPullRequestDraft,
    GitMerge,
    MessageSquare,
    RefreshCw,
    Search
} from 'lucide-react';
import {
    PULL_REQUEST_FILTERS,
    type BranchStatus,
    type GitHubRepoInfo,
    type PullRequest,
    type PullRequestFilter,
    type PullRequestSummary,
    type RepoRef
} from '@shared/github';
import { errorText, timeAgo } from '../util';
import { cacheKey, cached, remember } from '../data-cache';
import { focusFirstItem, moveListFocus } from '../keyboard/list-nav';
import { Combobox, sortedGroups } from './Combobox';
import { RepoIcon } from './RepoIcon';
import { ReviewPullRequest } from './ReviewPullRequest';

const api = window.shipwarden.github;
const FILTER_KEY = 'shipwarden.reviewFilter';
const POLL_MS = 60_000;

/** The cache keys. The view shows cached data immediately and loads new data in the background. */
const reposKey = (githubKey: string) => cacheKey('review.repos', githubKey);
const listKey = (scope: string, query: string) => cacheKey('review.list', scope, query);
const prKey = (repo: string, number: number) => cacheKey('review.pr', repo, number);
const repoOfKey = (path: string) => cacheKey('github.repoOf', path);

interface Props {
    /** A key for the GitHub providers of Settings › Code review. Undefined: not loaded yet. Null: no GitHub provider is on. */
    githubKey: string | null | undefined;
    /** The local repositories of all projects, in sidebar order. The entry page shows their GitHub repositories first. */
    localRepos: string[];
    /** Opens Settings > Code review. */
    onOpenSettings(): void;
    /** A pull request to open, for example from the Dashboard. A new `nonce` opens it again. */
    open?: ReviewOpenRequest;
    /** Opens the New worktree dialog on the head branch of a pull request. */
    onNewWorktree?(repo: RepoRef, pr: PullRequest): void;
}

export interface ReviewOpenRequest {
    /** "owner/name". */
    repo: string;
    number: number;
    tab: 'overview' | 'checks' | 'files';
    nonce: number;
}

function read(key: string): string | undefined {
    try {
        return localStorage.getItem(key) ?? undefined;
    } catch {
        return undefined;
    }
}

function write(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // The choice stays for this session only.
    }
}

function repoId(repo: RepoRef): string {
    return `${repo.owner}/${repo.name}`;
}

/**
 * Returns the GitHub repositories ("owner/name") of the local repositories, from their "origin" remotes.
 * The order is the order of the local repositories. A repository without a GitHub remote is not in the result.
 */
function useProjectRepos(paths: string[]): string[] {
    const [ids, setIds] = useState<string[]>(() => paths.flatMap(path => cached<string | null>(repoOfKey(path)) ?? []));
    useEffect(() => {
        let cancelled = false;
        Promise.all(
            paths.map(async path => {
                const ref = await api.repoOf(path).catch(() => null);
                return remember(repoOfKey(path), ref && repoId(ref));
            })
        ).then(result => {
            if (cancelled) return;
            const next = [...new Set(result.filter((id): id is string => !!id))];
            setIds(current => (current.join('\n') === next.join('\n') ? current : next));
        });
        return () => {
            cancelled = true;
        };
    }, [paths]);
    return ids;
}

interface RepoListProps {
    repos: GitHubRepoInfo[] | undefined;
    /** The GitHub repositories of the sidebar repositories, in sidebar order. */
    projectRepos: string[];
    error: string | undefined;
    loading: boolean;
    onSelect(repo: string): void;
    onRefresh(): void;
    onOpenSettings(): void;
}

/**
 * The entry page of the Review view, with a filter field. It shows the GitHub repositories of the sidebar repositories.
 * A button shows all the repositories of the GitHub providers, grouped by owner.
 */
function RepoList({ repos, projectRepos, error, loading, onSelect, onRefresh, onOpenSettings }: RepoListProps) {
    const [query, setQuery] = useState('');
    const [showAll, setShowAll] = useState(false);

    /** The provider repositories that are in a project, in sidebar order. GitHub names do not use case, so the match ignores case. */
    const inProjects = useMemo(() => {
        const byId = new Map((repos ?? []).map(item => [repoId(item).toLowerCase(), item]));
        return projectRepos.flatMap(id => byId.get(id.toLowerCase()) ?? []);
    }, [repos, projectRepos]);
    /** Without project repositories, the page shows all repositories. */
    const all = showAll || inProjects.length === 0;

    const groups = useMemo(() => {
        const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const matches = (all ? (repos ?? []) : inProjects).filter(item => words.every(word => repoId(item).toLowerCase().includes(word)));
        if (!all) {
            return matches.length ? [{ label: 'In your projects', items: matches.map(item => ({ value: repoId(item), label: repoId(item) })) }] : [];
        }
        return sortedGroups(
            matches,
            item => item.owner,
            item => ({ value: repoId(item), label: item.name })
        );
    }, [repos, inProjects, all, query]);

    const first = groups[0]?.items[0]?.value;
    const repoListRef = useRef<HTMLDivElement>(null);
    const showAllButton = (
        <button className="button review-show-all" onClick={() => setShowAll(true)}>
            Show all repositories{repos ? ` (${repos.length})` : ''}
        </button>
    );

    return (
        <>
            <header className="tasks-header review-header">
                <div className="tasks-header-group how">
                    <label className="tasks-search review-repo-filter">
                        <Search size={14} strokeWidth={1.6} />
                        <input
                            autoFocus
                            value={query}
                            placeholder="Filter repositories"
                            spellCheck={false}
                            onChange={event => setQuery(event.target.value)}
                            onKeyDown={event => {
                                if (event.key === 'Enter' && first) onSelect(first);
                                if (event.key === 'ArrowDown' && focusFirstItem(repoListRef.current)) event.preventDefault();
                            }}
                        />
                    </label>
                    {inProjects.length > 0 && (
                        <div className="segmented compact" role="radiogroup" aria-label="Repositories">
                            <button role="radio" aria-checked={!all} className={!all ? 'selected' : ''} onClick={() => setShowAll(false)}>
                                In projects
                            </button>
                            <button role="radio" aria-checked={all} className={all ? 'selected' : ''} onClick={() => setShowAll(true)}>
                                All
                            </button>
                        </div>
                    )}
                    <span className="header-spacer" />
                    <button className="icon-button" title="Refresh" onClick={onRefresh}>
                        <RefreshCw size={15} strokeWidth={1.6} className={loading ? 'spin' : ''} />
                    </button>
                </div>
            </header>
            <div className="review-list" ref={repoListRef} onKeyDown={moveListFocus}>
                {error && <div className="form-error task-list-error">{error}</div>}
                {!repos && !error && <div className="panel-message">Loading repositories…</div>}
                {repos?.length === 0 && (
                    <div className="review-empty">
                        <p>The selected organizations have no repositories that you can access.</p>
                        <button className="button" onClick={onOpenSettings}>
                            Open Settings › Code review
                        </button>
                    </div>
                )}
                {repos && repos.length > 0 && groups.length === 0 && (
                    <div className="panel-message">
                        {all ? 'No repositories match the filter.' : 'No repositories in your projects match the filter.'}
                        {!all && <div className="review-show-all-row">{showAllButton}</div>}
                    </div>
                )}
                {groups.map((group, index) => (
                    <section key={`${index}:${group.label}`} className="review-repo-group">
                        <h3 className="review-repo-owner">{group.label}</h3>
                        {group.items.map(item => (
                            <button key={item.value} className="review-item review-repo-item" data-nav-item onClick={() => onSelect(item.value)}>
                                <RepoIcon />
                                <span className="review-item-title">{item.label}</span>
                            </button>
                        ))}
                    </section>
                ))}
                {!all && groups.length > 0 && <div className="review-show-all-row">{showAllButton}</div>}
            </div>
        </>
    );
}

function StateIcon({ pr }: { pr: PullRequestSummary }) {
    const props = { size: 15, strokeWidth: 1.7 };
    if (pr.state === 'MERGED') return <GitMerge {...props} className="pr-state merged" />;
    if (pr.state === 'CLOSED') return <GitPullRequestClosed {...props} className="pr-state closed" />;
    if (pr.isDraft) return <GitPullRequestDraft {...props} className="pr-state draft" />;
    return <GitPullRequest {...props} className="pr-state open" />;
}

function ChecksIcon({ state }: { state: string | null }) {
    const props = { size: 13, strokeWidth: 2 };
    if (state === 'SUCCESS') return <CircleCheck {...props} className="ci success" />;
    if (state === 'FAILURE' || state === 'ERROR') return <CircleX {...props} className="ci failure" />;
    if (state === 'PENDING' || state === 'EXPECTED') return <CircleDot {...props} className="ci pending" />;
    return null;
}

const REVIEW_TEXT: Record<string, string> = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' };

/**
 * The Review view: the pull requests of one GitHub repository, from the organizations in Settings > Code review.
 * The view has three pages. The entry page shows the repositories. The list page shows the pull requests of one repository.
 * The pull request page shows one pull request and hides the list.
 * The user can read the diff, comment, approve or request changes, mark files as viewed, read the CI logs,
 * and merge a pull request when they have write access to the repository.
 */
export function ReviewView({ githubKey, localRepos, onOpenSettings, open, onNewWorktree }: Props) {
    const projectRepos = useProjectRepos(localRepos);
    const [repos, setRepos] = useState<GitHubRepoInfo[]>();
    const [repo, setRepo] = useState<string>();
    const [filter, setFilter] = useState<PullRequestFilter>(() =>
        PULL_REQUEST_FILTERS.some(item => item.id === read(FILTER_KEY)) ? (read(FILTER_KEY) as PullRequestFilter) : 'open'
    );
    const [query, setQuery] = useState('');
    const [list, setList] = useState<PullRequestSummary[]>();
    const [listLoading, setListLoading] = useState(false);
    const [error, setError] = useState<string>();
    const [reposLoading, setReposLoading] = useState(false);
    const [reposError, setReposError] = useState<string>();
    const [selected, setSelected] = useState<number>();
    const [pr, setPr] = useState<PullRequest | null>();
    const [prLoading, setPrLoading] = useState(false);
    const [prError, setPrError] = useState<string>();
    const prListRef = useRef<HTMLDivElement>(null);

    // The repositories of the GitHub providers, each in its organizations.
    const reposRequest = useRef(0);
    const loadRepos = useCallback(async () => {
        if (!githubKey) return;
        const id = ++reposRequest.current;
        setReposLoading(true);
        try {
            const result = await api.repositories();
            if (id !== reposRequest.current) return;
            setRepos(remember(reposKey(githubKey), result));
            setReposError(undefined);
        } catch (err) {
            if (id === reposRequest.current) setReposError(errorText(err));
        } finally {
            if (id === reposRequest.current) setReposLoading(false);
        }
    }, [githubKey]);
    useEffect(() => {
        if (!githubKey) return;
        setRepos(cached(reposKey(githubKey)));
        setReposError(undefined);
        void loadRepos();
    }, [githubKey, loadRepos]);

    const repoRef = useMemo<RepoRef | undefined>(() => {
        if (!repo) return undefined;
        const [owner, name] = repo.split('/');
        return { owner, name };
    }, [repo]);

    /** Each list request gets a number, so that a slow old response cannot replace a newer list. */
    const listRequest = useRef(0);
    const listScope = useRef<string | undefined>(undefined);
    const loadList = useCallback(async () => {
        if (!repoRef) return;
        const id = ++listRequest.current;
        const scope = cacheKey(repoId(repoRef), filter);
        const key = listKey(scope, query.trim());
        // A new repository or filter shows its last list, or nothing. A new search keeps the current list until the result comes.
        const last = cached<PullRequestSummary[]>(key);
        if (last || listScope.current !== scope) {
            setList(last);
        }
        listScope.current = scope;
        setListLoading(true);
        try {
            const result = await api.pullRequests(repoRef, filter, query);
            if (id !== listRequest.current) return;
            setList(remember(key, result));
            setError(undefined);
        } catch (err) {
            if (id === listRequest.current) setError(errorText(err));
        } finally {
            if (id === listRequest.current) setListLoading(false);
        }
    }, [repoRef, filter, query]);

    // Load the list after a short pause in typing, and again on a timer.
    useEffect(() => {
        const timer = setTimeout(loadList, query ? 350 : 0);
        return () => clearTimeout(timer);
    }, [loadList, query]);
    useEffect(() => {
        const timer = setInterval(loadList, POLL_MS);
        return () => clearInterval(timer);
    }, [loadList]);

    // A new repository starts with no selection, or with the pull request of an open request.
    const pendingOpen = useRef<ReviewOpenRequest | undefined>(undefined);
    useEffect(() => {
        const pending = pendingOpen.current;
        setSelected(pending && pending.repo === repo ? pending.number : undefined);
    }, [repo]);

    // An open request selects its repository and pull request.
    useEffect(() => {
        if (!open) return;
        pendingOpen.current = open;
        setRepo(open.repo);
        setSelected(open.number);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open?.nonce]);

    /** Each pull request request gets a number, so that a slow response for another pull request cannot show. */
    const prRequest = useRef(0);
    const loadPr = useCallback(async () => {
        if (!repoRef || !selected) return;
        const id = ++prRequest.current;
        setPrLoading(true);
        try {
            const result = await api.pullRequest(repoRef, selected);
            if (id !== prRequest.current) return;
            setPr(remember(prKey(repoId(repoRef), selected), result));
            setPrError(undefined);
        } catch (err) {
            if (id === prRequest.current) setPrError(errorText(err));
        } finally {
            if (id === prRequest.current) setPrLoading(false);
        }
    }, [repoRef, selected]);

    // A pull request shows its cached data immediately, and loads new data in the background.
    useEffect(() => {
        setPr(repoRef && selected ? cached<PullRequest>(prKey(repoId(repoRef), selected)) : undefined);
        setPrError(undefined);
        void loadPr();
    }, [loadPr]);

    const refresh = async () => {
        await Promise.all([loadPr(), loadList()]);
    };

    /** The panels take a branch status. In the Review view, it comes from the pull request. */
    const status: BranchStatus | undefined = repoRef && pr ? { repo: repoRef, branch: pr.headRefName, sha: pr.headRefOid, pullRequest: pr } : undefined;

    const selectRepo = (value: string) => {
        setRepo(value);
    };
    const selectFilter = (value: PullRequestFilter) => {
        setFilter(value);
        write(FILTER_KEY, value);
    };

    /** The repositories by owner, for the groups of the picker. */
    const groups = useMemo(
        () =>
            sortedGroups(
                repos ?? [],
                item => item.owner,
                item => ({ value: repoId(item), label: item.name })
            ),
        [repos]
    );

    if (githubKey === undefined) {
        return <div className="review-view" />;
    }
    if (githubKey === null) {
        return (
            <div className="review-view">
                <div className="review-empty">
                    <GitPullRequest size={30} strokeWidth={1.3} />
                    <h2>Review pull requests</h2>
                    <p>Add a GitHub provider to see its pull requests here.</p>
                    <button className="button primary" onClick={onOpenSettings}>
                        Open Settings › Code review
                    </button>
                </div>
            </div>
        );
    }

    if (!repo) {
        return (
            <div className="review-view">
                <RepoList
                    repos={repos}
                    projectRepos={projectRepos}
                    error={reposError}
                    loading={reposLoading}
                    onSelect={selectRepo}
                    onRefresh={() => void loadRepos()}
                    onOpenSettings={onOpenSettings}
                />
            </div>
        );
    }

    return (
        <div className="review-view">
            {!selected && (
                <header className="tasks-header review-header">
                    <div className="tasks-header-group where">
                        <button className="icon-button" title="All repositories" onClick={() => setRepo(undefined)}>
                            <ArrowLeft size={15} strokeWidth={1.7} />
                        </button>
                        <Combobox
                            className="review-repo-select"
                            value={repo}
                            groups={groups}
                            placeholder={!repos ? 'Loading repositories…' : repos.length === 0 ? 'No repositories' : 'Select a repository'}
                            searchPlaceholder="Search repositories"
                            disabled={!repos?.length}
                            title="Repository"
                            onChange={selectRepo}
                        />
                        <select
                            className="tasks-select"
                            value={filter}
                            title="Filter"
                            onChange={event => selectFilter(event.target.value as PullRequestFilter)}
                        >
                            {PULL_REQUEST_FILTERS.map(item => (
                                <option key={item.id} value={item.id}>
                                    {item.label}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="tasks-header-group how">
                        <label className="tasks-search">
                            <Search size={14} strokeWidth={1.6} />
                            <input
                                value={query}
                                placeholder="Search pull requests"
                                spellCheck={false}
                                onChange={event => setQuery(event.target.value)}
                                onKeyDown={event => {
                                    if (event.key === 'ArrowDown' && focusFirstItem(prListRef.current)) event.preventDefault();
                                }}
                            />
                        </label>
                        <span className="header-spacer" />
                        <button className="icon-button" title="Refresh" onClick={refresh}>
                            <RefreshCw size={15} strokeWidth={1.6} className={listLoading || prLoading ? 'spin' : ''} />
                        </button>
                    </div>
                </header>
            )}

            {repoRef && (
                <div className="review-body">
                    {/* The list stays in the page when it is hidden, so that it keeps its scroll position. */}
                    <div className="review-list" ref={prListRef} hidden={selected !== undefined} onKeyDown={moveListFocus}>
                        {error && <div className="form-error task-list-error">{error}</div>}
                        {!list && !error && <div className="panel-message">Loading pull requests…</div>}
                        {list?.length === 0 && <div className="panel-message">No pull requests.</div>}
                        {list?.map(item => (
                            <button key={item.number} className="review-item" data-nav-item onClick={() => setSelected(item.number)}>
                                <StateIcon pr={item} />
                                <span className="review-item-main">
                                    <span className="review-item-title">{item.title}</span>
                                    <span className="review-item-meta">
                                        #{item.number} · {item.author ?? 'unknown'}
                                        {item.viewerDidAuthor ? ' (you)' : ''} · {timeAgo(item.updatedAt)}
                                    </span>
                                    <span className="review-item-meta">
                                        {item.reviewDecision && (
                                            <span className={`review-decision ${item.reviewDecision.toLowerCase()}`}>{REVIEW_TEXT[item.reviewDecision]}</span>
                                        )}
                                        <span className="additions">+{item.additions}</span> <span className="deletions">−{item.deletions}</span>
                                        {item.comments > 0 && (
                                            <span className="review-comments">
                                                <MessageSquare size={11} strokeWidth={1.8} />
                                                {item.comments}
                                            </span>
                                        )}
                                    </span>
                                </span>
                                <ChecksIcon state={item.checks} />
                            </button>
                        ))}
                    </div>

                    {selected && (
                        <ReviewPullRequest
                            key={repo}
                            tabRequest={open && open.repo === repo && open.number === selected ? open : undefined}
                            repo={repoRef}
                            status={status}
                            pr={pr ?? undefined}
                            loading={prLoading}
                            error={prError}
                            onRefresh={refresh}
                            onBack={() => setSelected(undefined)}
                            onNewWorktree={onNewWorktree && (target => onNewWorktree(repoRef, target))}
                        />
                    )}
                </div>
            )}
        </div>
    );
}
