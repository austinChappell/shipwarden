import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleCheck, CircleDot, CircleX, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, GitMerge, MessageSquare, RefreshCw, Search } from 'lucide-react';
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
import { Combobox, sortedGroups } from './Combobox';
import { ReviewPullRequest } from './ReviewPullRequest';

const api = window.shipwarden.github;
const REPO_KEY = 'shipwarden.reviewRepo';
const FILTER_KEY = 'shipwarden.reviewFilter';
const POLL_MS = 60_000;

/**
 * The last repositories of each owner choice and the last list of each repository, filter and search.
 * The view shows them at once and loads new data at the same time.
 */
const repoCache = new Map<string, GitHubRepoInfo[]>();
const listCache = new Map<string, PullRequestSummary[]>();

interface Props {
    /** A key for the GitHub providers of Settings › Code review. Undefined: not loaded yet. Null: no GitHub provider is on. */
    githubKey: string | null | undefined;
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
 * The view has two pages. The list page shows the pull requests. The pull request page shows one pull request and hides the list.
 * The user can read the diff, comment, approve or request changes, mark files as viewed, read the CI logs,
 * and merge a pull request when they have write access to the repository.
 */
export function ReviewView({ githubKey, onOpenSettings, open, onNewWorktree }: Props) {
    const [repos, setRepos] = useState<GitHubRepoInfo[]>();
    const [repo, setRepo] = useState<string | undefined>(() => read(REPO_KEY));
    const [filter, setFilter] = useState<PullRequestFilter>(() => (PULL_REQUEST_FILTERS.some(item => item.id === read(FILTER_KEY)) ? read(FILTER_KEY) as PullRequestFilter : 'open'));
    const [query, setQuery] = useState('');
    const [list, setList] = useState<PullRequestSummary[]>();
    const [listLoading, setListLoading] = useState(false);
    const [error, setError] = useState<string>();
    const [selected, setSelected] = useState<number>();
    const [pr, setPr] = useState<PullRequest | null>();
    const [prLoading, setPrLoading] = useState(false);
    const [prError, setPrError] = useState<string>();

    // The repositories of the GitHub providers, each in its organizations.
    useEffect(() => {
        if (!githubKey) return;
        let cancelled = false;
        setRepos(repoCache.get(githubKey));
        setError(undefined);
        api.repositories().then(result => {
            if (cancelled) return;
            repoCache.set(githubKey, result);
            setRepos(result);
            setRepo(current => (current && result.some(item => repoId(item) === current) ? current : result[0] && repoId(result[0])));
        }, err => !cancelled && setError(errorText(err)));
        return () => {
            cancelled = true;
        };
    }, [githubKey]);

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
        const scope = `${repoId(repoRef)}\0${filter}`;
        const key = `${scope}\0${query.trim()}`;
        // A new repository or filter shows its last list, or nothing. A new search keeps the current list until the result comes.
        const cached = listCache.get(key);
        if (cached || listScope.current !== scope) {
            setList(cached);
        }
        listScope.current = scope;
        setListLoading(true);
        try {
            const result = await api.pullRequests(repoRef, filter, query);
            if (id !== listRequest.current) return;
            listCache.set(key, result);
            setList(result);
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
        write(REPO_KEY, open.repo);
        setSelected(open.number);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open?.nonce]);

    const loadPr = useCallback(async () => {
        if (!repoRef || !selected) return;
        setPrLoading(true);
        try {
            setPr(await api.pullRequest(repoRef, selected));
            setPrError(undefined);
        } catch (err) {
            setPrError(errorText(err));
        } finally {
            setPrLoading(false);
        }
    }, [repoRef, selected]);

    useEffect(() => {
        setPr(undefined);
        loadPr();
    }, [loadPr]);

    const refresh = async () => {
        await Promise.all([loadPr(), loadList()]);
    };

    /** The panels take a branch status. In the Review view, it comes from the pull request. */
    const status: BranchStatus | undefined = repoRef && pr ? { repo: repoRef, branch: pr.headRefName, sha: pr.headRefOid, pullRequest: pr } : undefined;

    const selectRepo = (value: string) => {
        setRepo(value);
        write(REPO_KEY, value);
    };
    const selectFilter = (value: PullRequestFilter) => {
        setFilter(value);
        write(FILTER_KEY, value);
    };

    /** The repositories by owner, for the groups of the picker. */
    const groups = useMemo(() => sortedGroups(repos ?? [], item => item.owner, item => ({ value: repoId(item), label: item.name })), [repos]);

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
                    <button className="button primary" onClick={onOpenSettings}>Open Settings › Code review</button>
                </div>
            </div>
        );
    }

    return (
        <div className="review-view">
            {!selected && <header className="tasks-header review-header">
                <div className="tasks-header-group where">
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
                    <select className="tasks-select" value={filter} title="Filter" onChange={event => selectFilter(event.target.value as PullRequestFilter)}>
                        {PULL_REQUEST_FILTERS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                </div>
                <div className="tasks-header-group how">
                    <label className="tasks-search">
                        <Search size={14} strokeWidth={1.6} />
                        <input value={query} placeholder="Search pull requests" spellCheck={false} onChange={event => setQuery(event.target.value)} />
                    </label>
                    <span className="header-spacer" />
                    <button className="icon-button" title="Refresh" onClick={refresh}>
                        <RefreshCw size={15} strokeWidth={1.6} className={listLoading || prLoading ? 'spin' : ''} />
                    </button>
                </div>
            </header>}

            {!selected && repos?.length === 0 && (
                <div className="review-empty">
                    <p>The selected organizations have no repositories that you can access.</p>
                    <button className="button" onClick={onOpenSettings}>Open Settings › Code review</button>
                </div>
            )}

            {repoRef && (
                <div className="review-body">
                    {/* The list stays in the page when it is hidden, so that it keeps its scroll position. */}
                    <div className="review-list" hidden={selected !== undefined}>
                        {error && <div className="form-error task-list-error">{error}</div>}
                        {!list && !error && <div className="panel-message">Loading pull requests…</div>}
                        {list?.length === 0 && <div className="panel-message">No pull requests.</div>}
                        {list?.map(item => (
                            <button key={item.number} className="review-item" onClick={() => setSelected(item.number)}>
                                <StateIcon pr={item} />
                                <span className="review-item-main">
                                    <span className="review-item-title">{item.title}</span>
                                    <span className="review-item-meta">
                                        #{item.number} · {item.author ?? 'unknown'}{item.viewerDidAuthor ? ' (you)' : ''} · {timeAgo(item.updatedAt)}
                                    </span>
                                    <span className="review-item-meta">
                                        {item.reviewDecision && <span className={`review-decision ${item.reviewDecision.toLowerCase()}`}>{REVIEW_TEXT[item.reviewDecision]}</span>}
                                        <span className="additions">+{item.additions}</span> <span className="deletions">−{item.deletions}</span>
                                        {item.comments > 0 && <span className="review-comments"><MessageSquare size={11} strokeWidth={1.8} />{item.comments}</span>}
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
