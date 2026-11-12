import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Bot, Check, ExternalLink, FolderGit2, FolderInput, Layers, Link, ListChecks, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { pluralize } from '@shared/format';
import type { BranchStatus, CheckRun, DiffSide, PullRequest, PullRequestCommit, PullRequestFile, RepoRef } from '@shared/github';
import type { ProjectsState, PullRepoTarget } from '@shared/projects';
import type { Worktree } from '@shared/worktrees';
import { keyRoots } from '../query-client';
import { reviewStore, useReviewState } from '../github/review-store';
import { errorText, timeAgo } from '../util';
import { ChecksPanel } from './ChecksPanel';
import { CommitView } from './CommitView';
import { LogView } from './LogView';
import { PullRequestFilesStream } from './PullRequestFilesStream';
import { BranchName, ConflictBadge, PullRequestCommitList, PullRequestFileList, PullRequestPanel, StateBadge } from './PullRequestPanel';
import { PullRequestSummary } from './PullRequestSummary';
import { useCheckCounts, type CheckCounts } from '../github/use-check-counts';
import { ResizeHandle, usePanelWidth } from './ResizeHandle';
import { openLink } from '../links';
import { AGENT_REVIEW_TITLE } from './PullRequestReviewCard';
import { Button, ButtonGroup, Count, IconButton, SplitButton, type SplitMenuItem } from './ui';
import { EmptyState } from './EmptyState';
import { pullRequestKeyAction } from '@shared/shortcuts';
import { HelmLoader } from './HelmLoader';
import { FileExplorer } from './FileExplorer';
import { ErrorBanner } from './ErrorBanner';
import { CheckoutMessage, ReviewCodeView, type CodeLocation } from './ReviewCodeView';
import { reviewCheckouts, useReviewCheckout } from '../github/review-checkout-store';
import { lspBridge } from '../lsp/bridge';
import { documents } from '../editor/documents';
import { moveTabFocus } from '../tablist';
import { PullRepoDialog } from './PullRepoDialog';
import { AddToGroupDialog } from './AddToGroupDialog';
import { isFindShortcut, openLogFind } from './log-find';
import { findRequest as makeFindRequest, type FindRequest } from './selected-text';

export type ReviewTab = 'overview' | 'commits' | 'checks' | 'files';

const TAB_KEY = 'shipwarden.reviewTab';
const FILE_LIST_KEY = 'shipwarden.reviewFileList';
const FILE_SIDE_KEY = 'shipwarden.reviewFileSide';

/** The list beside the changed files: only the changed files, or all files of the pull request. */
type FileSide = 'changed' | 'all';

/** The code pane: the location that shows, and the locations that "Back" goes to. */
interface CodeHistory {
    current: CodeLocation;
    back: CodeLocation[];
}

/** An action of the header of a pull request: the main button or an item of its menu. */
type HeaderAction = Exclude<SplitMenuItem, 'separator'>;

/** The handlers of ⌘O and ⇧⌘O. Undefined when the action is not available. */
interface HeaderKeys {
    openWorktree?(): void;
    openOnHost?(): void;
}

/** Renders the component again each 30 seconds, so a relative time such as "synced 2m ago" stays correct. */
function useTick(): void {
    const [, setTick] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => setTick(value => value + 1), 30_000);
        return () => clearInterval(timer);
    }, []);
}

function readFileSide(): FileSide {
    try {
        return localStorage.getItem(FILE_SIDE_KEY) === 'all' ? 'all' : 'changed';
    } catch {
        return 'changed';
    }
}

interface Props {
    repo: RepoRef;
    /** The branch status from the pull request. Undefined while it loads. */
    status: BranchStatus | undefined;
    pr: PullRequest | undefined;
    loading: boolean;
    /** The time of the last load of the pull request, in milliseconds. 0 or undefined when it did not load. */
    syncedAt?: number;
    error?: string;
    onRefresh(): Promise<void>;
    /** Shows the list of pull requests again. */
    onBack(): void;
    /** The tab of the history entry. Undefined shows the tab that the user selected last. */
    tab?: ReviewTab;
    /** Tells the history entry that a different tab shows. */
    onSelectTab?(tab: ReviewTab): void;
    /**
     * Opens the worktree of the head branch of the pull request. When no worktree has the branch, it opens the New worktree
     * dialog on the branch. Without it, the button and the link do not show.
     */
    onNewWorktree?(pr: PullRequest): void;
    /**
     * Sends a prompt to the agent of the worktree of the head branch. Without it, or when no project has the repository,
     * the threads and the conflicts banner have no "Send to agent" button.
     */
    onSendToAgent?(pr: PullRequest, prompt: string): void;
    /** Sends the log of a check to the agent of the worktree of the head branch. Without it, the Checks tab has no button. */
    onSendLogToAgent?(pr: PullRequest, check: CheckRun): void;
    /** Sends the failed checks to the agent of the worktree of the head branch. Without it, the CI banner has no button. */
    onSendChecksToAgent?(pr: PullRequest, checks: CheckRun[]): void;
    /** The projects. Undefined while they load. */
    projects?: ProjectsState;
    /** Adds the repository to a project. Without it, the "Pull into project" button does not show. */
    onPullRepo?(target: PullRepoTarget): Promise<boolean>;
    /** Opens the page of a PR group. Without it, the "Add to a PR group" item does not show. */
    onOpenGroup?(id: string): void;
}

/**
 * The main worktree of the project repository that is a clone of the repository. Null when no project has a clone.
 * Undefined while the check runs. The check runs again when the projects change.
 */
function useRepoClone(repo: RepoRef, projects: ProjectsState | undefined): string | null | undefined {
    const [clone, setClone] = useState<string | null>();
    useEffect(() => {
        if (!projects) return;
        let current = true;
        window.shipwarden.projects.findRepo(repo).then(
            root => current && setClone(root),
            () => current && setClone(undefined)
        );
        return () => {
            current = false;
        };
    }, [repo, projects]);
    return clone;
}

/**
 * The worktree of the clone that has the branch. Undefined when no worktree has it, or while the list loads.
 * The sidebar writes the worktree lists of the active project into the cache, so a new worktree shows at once.
 */
function useBranchWorktree(clone: string | null | undefined, branch: string | undefined): Worktree | undefined {
    const { data } = useQuery({
        queryKey: [...keyRoots.worktrees, clone],
        queryFn: () => window.shipwarden.worktrees.list(clone ?? ''),
        enabled: !!clone
    });
    return branch ? data?.find(worktree => worktree.branch === branch) : undefined;
}

/** True when the text is the name of a tab of a pull request. */
export function isReviewTab(value: string | undefined): value is ReviewTab {
    return value === 'overview' || value === 'commits' || value === 'checks' || value === 'files';
}

function readTab(): ReviewTab {
    try {
        const value = localStorage.getItem(TAB_KEY) ?? undefined;
        return isReviewTab(value) ? value : 'overview';
    } catch {
        return 'overview';
    }
}

/** True when the file list of the Files changed tab shows. It shows when no choice is saved. */
function readFileListOpen(): boolean {
    try {
        return localStorage.getItem(FILE_LIST_KEY) !== 'hidden';
    } catch {
        return true;
    }
}

function Tab({ id, current, label, count, onSelect }: { id: ReviewTab; current: ReviewTab; label: string; count?: ReactNode; onSelect(id: ReviewTab): void }) {
    // ← and → move the focus to the previous or the next tab. That tab then shows.
    return (
        <button
            role="tab"
            aria-selected={id === current}
            tabIndex={id === current ? 0 : -1}
            className={`pr-tab${id === current ? ' selected' : ''}`}
            onClick={() => onSelect(id)}
            onKeyDown={event => moveTabFocus(event)?.click()}
        >
            <span>{label}</span>
            {count}
        </button>
    );
}

/** The count of the Checks tab: a neutral count badge. An icon after it shows a failed result or a passed result. */
function CheckTabCount({ total, counts }: { total: number; counts: CheckCounts | undefined }) {
    if (!counts || counts.total === 0) return <Count value={total} />;
    if (counts.failed > 0)
        return (
            <span className="pr-check-count failure" title={`${counts.failed} failed`}>
                <Count value={counts.total} />
                <X size={12} strokeWidth={2.4} aria-hidden="true" />
            </span>
        );
    if (counts.running > 0) return <Count value={counts.total} label={`${counts.running} running`} />;
    return (
        <span className="pr-check-count success" title="All checks passed">
            <Count value={counts.total} />
            <Check size={12} strokeWidth={2.4} aria-hidden="true" />
        </span>
    );
}

/**
 * A pull request in the Review view, with the tabs of GitHub: Overview, Commits, Checks and Files changed.
 * The tab stays the same when the user opens a different pull request.
 */
export function ReviewPullRequest({
    repo,
    status,
    pr,
    loading,
    syncedAt,
    error,
    onRefresh,
    onBack,
    tab: routeTab,
    onSelectTab,
    onNewWorktree,
    onSendToAgent,
    onSendLogToAgent,
    onSendChecksToAgent,
    projects,
    onPullRepo,
    onOpenGroup
}: Props) {
    const [storedTab, setTab] = useState<ReviewTab>(readTab);
    const tab = routeTab ?? storedTab;
    const onSelectTabRef = useRef(onSelectTab);
    onSelectTabRef.current = onSelectTab;
    // The render writes the newest handlers. The key listener attaches one time.
    const headerKeys = useRef<HeaderKeys>({});
    useTick();
    // The tab of the history entry stays when the user opens a different pull request without a tab.
    useEffect(() => {
        if (routeTab) setTab(routeTab);
    }, [routeTab]);
    // The commit that the Commits tab shows. Undefined shows the commit list.
    const [commitSha, setCommitSha] = useState<string>();
    const openCommit = (commit: PullRequestCommit) => {
        setCommitSha(commit.oid);
        selectTab('commits');
    };
    const clone = useRepoClone(repo, projects);
    const inProject = clone === undefined ? undefined : clone !== null;
    const branchWorktree = useBranchWorktree(clone, pr?.headRefName);
    const [pullOpen, setPullOpen] = useState(false);
    const [groupOpen, setGroupOpen] = useState(false);
    const [file, setFile] = useState<{ file: PullRequestFile; line?: number; side?: DiffSide; nonce: number }>();
    const [check, setCheck] = useState<CheckRun>();
    const [fileError, setFileError] = useState<string>();
    const [findRequest, setFindRequest] = useState<FindRequest>();
    const review = useReviewState(repo, pr?.number);
    const checkCounts = useCheckCounts(repo, status?.sha);
    const sideWidth = usePanelWidth('shipwarden.width.reviewSide', 320, 220, 560);
    const [fileListOpen, setFileListOpen] = useState(readFileListOpen);
    const [fileSide, setFileSide] = useState<FileSide>(readFileSide);
    const [code, setCode] = useState<CodeHistory>();
    /** The cursor in the code pane. "Back" goes to this position, not to the start of the file. */
    const cursorRef = useRef<{ path: string; line: number; column: number } | undefined>(undefined);
    const codeWidth = usePanelWidth('shipwarden.width.reviewCode', 560, 320, 1400);
    const checkout = useReviewCheckout(repo, pr?.number);
    const checkoutRoot = checkout.status === 'ready' ? checkout.root : undefined;

    /** Shows a location in the code pane. The location before it goes to the "Back" list. */
    const openCode = (location: Omit<CodeLocation, 'nonce'>) => {
        const next = { ...location, nonce: Date.now() };
        setCode(history => {
            if (!history) return { current: next, back: [] };
            const cursor = cursorRef.current;
            const previous =
                cursor && cursor.path === history.current.path
                    ? { path: cursor.path, line: cursor.line, column: cursor.column, nonce: 0 }
                    : { ...history.current, action: undefined };
            return { current: next, back: [...history.back, previous].slice(-50) };
        });
    };
    const openCodeRef = useRef(openCode);
    openCodeRef.current = openCode;

    const goBack = () =>
        setCode(history => {
            if (!history?.back.length) return history;
            const previous = history.back[history.back.length - 1];
            return { current: { ...previous, nonce: Date.now() }, back: history.back.slice(0, -1) };
        });

    /** Gets the local copy of the pull request. The state of the copy shows in the code pane and the file side. */
    const ensureCheckout = () => {
        if (pr) void reviewCheckouts.ensure(repo, pr);
    };

    const changeFileSide = (value: FileSide) => {
        setFileSide(value);
        if (value === 'all') ensureCheckout();
        try {
            localStorage.setItem(FILE_SIDE_KEY, value);
        } catch {
            // The choice stays for this session only.
        }
    };

    const toggleFileList = () => {
        const value = !fileListOpen;
        setFileListOpen(value);
        try {
            localStorage.setItem(FILE_LIST_KEY, value ? 'shown' : 'hidden');
        } catch {
            // The choice stays for this session only.
        }
    };

    const selectTab = (value: ReviewTab) => {
        // A click on the Commits tab while it shows a commit goes back to the commit list.
        if (value === 'commits' && tab === 'commits') setCommitSha(undefined);
        setTab(value);
        onSelectTabRef.current?.(value);
        // The Files changed tab opens the search bar again only after a new ⌘F.
        if (value !== 'files') setFindRequest(undefined);
        try {
            localStorage.setItem(TAB_KEY, value);
        } catch {
            // The tab stays for this session only.
        }
    };

    // ⌘F searches the changed files when no CI log owns ⌘F. The capture phase gets the key before a comment box can stop it.
    // The selected text of the page goes into the search field.
    // The listener also runs ⌘O and ⇧⌘O of the header.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The listener attaches one time. selectTab uses only state setters and a ref, so the first copy is correct.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (isFindShortcut(event) && !openLogFind(event)) {
                event.preventDefault();
                // Read the selection before the search field gets the focus.
                setFindRequest(makeFindRequest());
                selectTab('files');
                return;
            }
            // ⌘O opens the worktree of the head branch. ⇧⌘O opens the pull request on GitHub.
            const action = pullRequestKeyAction(event);
            const run = action && headerKeys.current[action];
            if (run) {
                event.preventDefault();
                run();
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, []);

    // A different pull request starts with no file and no log.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The effect clears the state when the repository or the pull request changes.
    useEffect(() => {
        setFile(undefined);
        setCheck(undefined);
        setFileError(undefined);
        setCode(undefined);
        cursorRef.current = undefined;
    }, [repo.owner, repo.name, pr?.number]);

    // The list of all files needs the copy. A new head commit updates the copy.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The copy state is not a dependency. Else a copy that the user refused starts again at once.
    useEffect(() => {
        if (tab === 'files' && fileSide === 'all' && checkout.status !== 'working') ensureCheckout();
    }, [tab, fileSide, repo.owner, repo.name, pr?.number, pr?.headRefOid]);

    // The language servers get the copy as a root. "Go to definition" into another file opens it in the code pane.
    useEffect(() => {
        if (!checkoutRoot) return;
        const removeRoot = lspBridge.addRoot(checkoutRoot, (_root, path, line, column) => openCodeRef.current({ path, line, column }));
        return () => {
            removeRoot();
            // The editor of the code pane releases its model first. Its cleanup runs in the same commit.
            setTimeout(() => documents.closeRoot(checkoutRoot));
            void window.shipwarden.review.release(checkoutRoot).catch(() => undefined);
        };
    }, [checkoutRoot]);

    const prNumber = pr?.number;
    // biome-ignore lint/correctness/useExhaustiveDependencies: A new head commit loads the file list again.
    useEffect(() => {
        if (prNumber !== undefined) {
            reviewStore.loadFiles(repo, prNumber).catch(err => setFileError(errorText(err)));
        }
    }, [repo, prNumber, pr?.headRefOid]);

    const files = review.files;
    const agentReview = review.agentReview;

    const back = (
        <Button
            variant="ghost"
            size="sm"
            className="review-back"
            icon={<ArrowLeft size={14} strokeWidth={1.6} />}
            title="Show all pull requests"
            onClick={onBack}
        >
            {repo.owner}/{repo.name}
        </Button>
    );

    if (!pr) {
        return (
            <div className={`review-pr${tab === 'overview' ? ' overview' : ''}`}>
                <header className="review-pr-header">{back}</header>
                {!error && loading ? <HelmLoader label="Loading the pull request" /> : <div className="review-placeholder panel-message">{error ?? ''}</div>}
            </div>
        );
    }

    const openFile = (target: PullRequestFile, line?: number, side?: DiffSide) => {
        setFile({ file: target, line, side, nonce: Date.now() });
        selectTab('files');
    };
    const current = file && files?.find(item => item.path === file.file.path);
    // A commit that is not in the pull request now (for example after a force push) shows the commit list.
    const selectedCommit = commitSha ? pr.commits.find(commit => commit.oid === commitSha) : undefined;
    // The agent works in a worktree of the head branch. That needs a clone of the repository in a project.
    const sendToAgent = inProject && onSendToAgent ? (prompt: string) => onSendToAgent(pr, prompt) : undefined;
    const sendLogToAgent = inProject && onSendLogToAgent ? (target: CheckRun) => onSendLogToAgent(pr, target) : undefined;
    const style = { '--review-side-width': `${sideWidth.width}px` } as CSSProperties;
    const sideMax = () => (document.querySelector<HTMLElement>('.pr-tab-body')?.offsetWidth ?? Infinity) - 320;
    /** The code pane leaves space for the file list and for a narrow diff. */
    const codeMax = () => (document.querySelector<HTMLElement>('.pr-tab-body')?.offsetWidth ?? Infinity) - (fileListOpen ? sideWidth.width : 0) - 320;

    const openOnHost = () => openLink(pr.url);
    const runAgentReview = () => void reviewStore.runAgentReview(repo, pr);
    /** Opens the worktree of the head branch, or makes one. A branch in a fork cannot get a worktree. */
    const worktreeAction: HeaderAction | undefined = onNewWorktree && {
        label: branchWorktree ? 'Open worktree' : 'New worktree',
        icon: <FolderGit2 size={14} strokeWidth={1.6} />,
        shortcut: '⌘O',
        title: branchWorktree
            ? `Open the worktree ${branchWorktree.path}`
            : pr.isCrossRepository
              ? `The branch ${pr.headRefName} is in a fork. ShipWarden can make a worktree only from a branch of origin.`
              : `Make a worktree from the branch ${pr.headRefName}`,
        disabled: !branchWorktree && pr.isCrossRepository,
        onSelect: () => onNewWorktree(pr)
    };
    const pullAction: HeaderAction | undefined =
        onPullRepo && inProject === false
            ? {
                  label: 'Pull into project',
                  icon: <FolderInput size={14} strokeWidth={1.6} />,
                  title: `No project has a clone of ${repo.owner}/${repo.name}. Clone it and add it to a project.`,
                  onSelect: () => setPullOpen(true)
              }
            : undefined;
    const hostAction: HeaderAction = {
        label: 'Open on GitHub',
        icon: <ExternalLink size={14} strokeWidth={1.6} />,
        shortcut: '⇧⌘O',
        onSelect: openOnHost
    };
    // Without a clone, the main button adds the repository to a project. Else it opens the worktree.
    const mainAction = pullAction ?? (worktreeAction && !worktreeAction.disabled ? worktreeAction : hostAction);
    const menuItems: SplitMenuItem[] = [
        ...(pullAction ? [pullAction] : []),
        ...(worktreeAction ? [worktreeAction] : []),
        hostAction,
        'separator',
        {
            label: 'Copy PR link',
            icon: <Link size={14} strokeWidth={1.6} />,
            onSelect: () => void navigator.clipboard.writeText(pr.url).catch(() => undefined)
        },
        ...(onOpenGroup
            ? [
                  {
                      label: 'Add to a PR group…',
                      icon: <Layers size={14} strokeWidth={1.6} />,
                      title: 'An agent reviews the pull requests of a group together, also across repositories.',
                      onSelect: () => setGroupOpen(true)
                  }
              ]
            : []),
        ...(pr.state === 'OPEN'
            ? [
                  'separator' as const,
                  {
                      label: agentReview?.status === 'running' ? 'Agent review in progress' : 'Run agent review',
                      icon: <Bot size={14} strokeWidth={1.6} />,
                      title: AGENT_REVIEW_TITLE,
                      disabled: agentReview?.status === 'running',
                      onSelect: runAgentReview
                  }
              ]
            : [])
    ];
    headerKeys.current = { openWorktree: worktreeAction?.disabled ? undefined : worktreeAction?.onSelect, openOnHost };

    return (
        <div className={`review-pr${tab === 'overview' ? ' overview' : ''}`}>
            <header className="review-pr-header">
                <div className="review-pr-top">
                    <div className="review-pr-heading">
                        {back}
                        <h2 className="review-pr-title">
                            {pr.title} <span className="review-pr-number">#{pr.number}</span>
                            <IconButton
                                size="sm"
                                className="review-pr-host-link"
                                icon={<ExternalLink size={14} strokeWidth={1.6} />}
                                label="Open on GitHub (⇧⌘O)"
                                onClick={event => openLink(pr.url, event)}
                            />
                        </h2>
                    </div>
                    <div className="review-pr-actions">
                        <SplitButton
                            label={mainAction.label}
                            icon={mainAction.icon}
                            title={mainAction.title}
                            onClick={mainAction.onSelect}
                            items={menuItems}
                            menuTitle="More actions for this pull request"
                            size="lg"
                        />
                        <IconButton
                            size="lg"
                            label="Refresh"
                            icon={<RefreshCw size={16} strokeWidth={1.6} className={loading ? 'spin' : ''} />}
                            disabled={loading}
                            onClick={() => void onRefresh()}
                        />
                    </div>
                </div>
                <div className="review-pr-meta">
                    <StateBadge pr={pr} />
                    <ConflictBadge pr={pr} />
                    <span className="review-pr-summary">
                        <strong>{pr.author?.login ?? 'unknown'}</strong>{' '}
                        {pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'wanted to merge' : 'wants to merge'} {pluralize(pr.commitCount, 'commit')}{' '}
                        into <code>{pr.baseRefName}</code> from <BranchName name={pr.headRefName} />
                        <span className="dot-separator">·</span>
                        opened {timeAgo(pr.createdAt)}
                        {syncedAt ? (
                            <>
                                <span className="dot-separator">·</span>
                                synced {timeAgo(new Date(syncedAt).toISOString())}
                            </>
                        ) : null}
                    </span>
                </div>
                {agentReview?.status === 'running' && tab !== 'overview' && (
                    <div className="agent-review-status running" role="status">
                        <LoaderCircle size={13} className="spin" />
                        <span>Agent review in progress</span>
                        <Button variant="link" onClick={() => reviewStore.cancelAgentReview(repo, pr.number)}>
                            Cancel
                        </Button>
                    </div>
                )}
                {agentReview && agentReview.status !== 'running' && (
                    <div className={`agent-review-status ${agentReview.status}`}>
                        {agentReview.status === 'done' && (
                            <>
                                <Bot size={13} strokeWidth={1.6} />
                                <span>
                                    {agentReview.agent} added {pluralize(agentReview.comments, 'pending comment')} and a summary to your review
                                    {agentReview.notes ? ` (with ${pluralize(agentReview.notes, 'note')} that are not on a changed line)` : ''}. Accept or
                                    remove each comment, then submit the review as yourself.
                                </span>
                                <Button variant="link" onClick={() => selectTab('files')}>
                                    Show comments
                                </Button>
                                <Button variant="link" onClick={() => selectTab('overview')}>
                                    Show summary
                                </Button>
                            </>
                        )}
                        {agentReview.status === 'error' && <span className="agent-review-error">The agent review failed: {agentReview.error}</span>}
                        <IconButton size="sm" icon={<X size={14} />} label="Close" onClick={() => reviewStore.dismissAgentReview(repo, pr.number)} />
                    </div>
                )}
                <PullRequestSummary pr={pr} checks={checkCounts} onSelectTab={selectTab} />
            </header>
            {groupOpen && onOpenGroup && <AddToGroupDialog repo={repo} pr={pr} onClose={() => setGroupOpen(false)} onOpenGroup={onOpenGroup} />}
            {pullOpen && onPullRepo && projects && (
                <PullRepoDialog repo={repo} projects={projects.projects} activeId={projects.activeId} onClose={() => setPullOpen(false)} onPull={onPullRepo} />
            )}

            <nav className="pr-tabs" role="tablist">
                <Tab id="overview" current={tab} onSelect={selectTab} label="Overview" />
                <Tab id="commits" current={tab} onSelect={selectTab} label="Commits" count={<Count value={pr.commitCount} />} />
                <Tab id="checks" current={tab} onSelect={selectTab} label="Checks" count={<CheckTabCount total={pr.checkCount} counts={checkCounts} />} />
                <Tab id="files" current={tab} onSelect={selectTab} label="Files changed" count={<Count value={pr.changedFiles} />} />
                <span className="pr-tabs-spacer" />
                {tab !== 'overview' && review.pending.length > 0 && pr.state === 'OPEN' && (
                    <Button variant="primary" className="pr-finish" onClick={() => selectTab('overview')}>
                        Finish review <Count value={review.pending.length} tone="on-primary" />
                    </Button>
                )}
            </nav>

            <div className="pr-tab-body" style={style}>
                {tab === 'overview' && (
                    <div className="pr-overview">
                        <PullRequestPanel
                            variant="overview"
                            target={repo}
                            status={status}
                            loading={loading}
                            error={error}
                            onRefresh={onRefresh}
                            onOpenDiff={(_pr, target, line, side) => openFile(target, line, side)}
                            checks={checkCounts}
                            onSendToAgent={sendToAgent}
                            onOpenCommit={openCommit}
                            onSendChecksToAgent={inProject && onSendChecksToAgent ? checks => onSendChecksToAgent(pr, checks) : undefined}
                            agentReview={{
                                running: agentReview?.status === 'running',
                                run: runAgentReview,
                                cancel: () => reviewStore.cancelAgentReview(repo, pr.number)
                            }}
                        />
                    </div>
                )}

                {tab === 'commits' &&
                    (selectedCommit ? (
                        <CommitView
                            key={selectedCommit.oid}
                            target={repo}
                            pr={pr}
                            commit={selectedCommit}
                            onBack={() => setCommitSha(undefined)}
                            onSelect={commit => setCommitSha(commit.oid)}
                        />
                    ) : (
                        <div className="pr-commits">
                            <PullRequestCommitList pr={pr} onOpen={commit => setCommitSha(commit.oid)} />
                        </div>
                    ))}

                {tab === 'checks' && (
                    <>
                        <div className="pr-side">
                            <ChecksPanel
                                key={`${repo.owner}/${repo.name}#${pr.number}`}
                                target={repo}
                                status={status}
                                onOpenLog={setCheck}
                                onSendLogToAgent={sendLogToAgent}
                            />
                        </div>
                        <ResizeHandle panel={sideWidth} edge="right" label="Resize the check list" maxAvailable={sideMax} />
                        <div className="review-content">
                            {check ? (
                                <LogView key={check.id} target={repo} check={check} onSendToAgent={sendLogToAgent} />
                            ) : (
                                <EmptyState icon={ListChecks} title="No check selected">
                                    Pick a check to read its log.
                                </EmptyState>
                            )}
                        </div>
                    </>
                )}

                {tab === 'files' && (
                    <>
                        {fileListOpen && (
                            <>
                                <div className={`pr-side ${fileSide === 'all' ? 'pr-all-files' : 'pr-file-side'}`}>
                                    <ButtonGroup size="sm" className="pr-file-side-switch" role="radiogroup" label="Files">
                                        <Button role="radio" aria-checked={fileSide === 'changed'} onClick={() => changeFileSide('changed')}>
                                            Changed
                                        </Button>
                                        <Button role="radio" aria-checked={fileSide === 'all'} onClick={() => changeFileSide('all')}>
                                            All files
                                        </Button>
                                    </ButtonGroup>
                                    {fileError && <div className="form-error">{fileError}</div>}
                                    {fileSide === 'changed' && (
                                        <section className="pr-section">
                                            <PullRequestFileList
                                                target={repo}
                                                pr={pr}
                                                files={files}
                                                selectedPath={current?.path}
                                                onOpen={target => openFile(target)}
                                                onError={setFileError}
                                            />
                                        </section>
                                    )}
                                    {fileSide === 'all' &&
                                        (checkoutRoot ? (
                                            <FileExplorer
                                                key={checkoutRoot}
                                                root={checkoutRoot}
                                                title={`${repo.name} #${pr.number}`}
                                                activePath={code?.current.path}
                                                onOpenFile={(path, line) => openCode({ path, line })}
                                            />
                                        ) : (
                                            <CheckoutMessage checkout={checkout} onRetry={ensureCheckout} />
                                        ))}
                                </div>
                                <ResizeHandle panel={sideWidth} edge="right" label="Resize the file list" maxAvailable={sideMax} />
                            </>
                        )}
                        <div className="review-content">
                            {/* Without the file list, the error shows above the diffs. A click removes it. */}
                            {!fileListOpen && fileError && <ErrorBanner onClose={() => setFileError(undefined)}>{fileError}</ErrorBanner>}
                            <div className="review-stream">
                                <PullRequestFilesStream
                                    key={`${repo.owner}/${repo.name}#${pr.number}`}
                                    target={repo}
                                    pr={pr}
                                    files={files}
                                    scrollTo={file && { path: file.file.path, line: file.line, side: file.side, nonce: file.nonce }}
                                    findRequest={findRequest}
                                    fileList={{ open: fileListOpen, toggle: toggleFileList }}
                                    onRefresh={onRefresh}
                                    onSendToAgent={sendToAgent}
                                    onError={setFileError}
                                    onGoToDefinition={(path, line, column) => {
                                        openCode({ path, line, column, action: 'definition' });
                                        ensureCheckout();
                                    }}
                                    onOpenFile={path => {
                                        openCode({ path });
                                        ensureCheckout();
                                    }}
                                />
                            </div>
                        </div>
                        {code && (
                            <>
                                <ResizeHandle panel={codeWidth} edge="left" label="Resize the code" maxAvailable={codeMax} />
                                <div className="review-code-pane" style={{ width: codeWidth.width }}>
                                    <ReviewCodeView
                                        root={checkoutRoot}
                                        checkout={checkout}
                                        location={code.current}
                                        canGoBack={code.back.length > 0}
                                        onBack={goBack}
                                        onClose={() => setCode(undefined)}
                                        onRetry={ensureCheckout}
                                        onCursor={(path, line, column) => {
                                            cursorRef.current = { path, line, column };
                                        }}
                                    />
                                </div>
                            </>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
