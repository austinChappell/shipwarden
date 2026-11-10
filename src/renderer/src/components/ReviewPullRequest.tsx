import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowLeft, Bot, Check, ExternalLink, FolderGit2, FolderInput, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { BranchStatus, CheckRun, PullRequest, PullRequestFile, RepoRef } from '@shared/github';
import type { ProjectsState, PullRepoTarget } from '@shared/projects';
import { reviewStore, useReviewState } from '../github/review-store';
import { errorText, timeAgo } from '../util';
import { ChecksPanel } from './ChecksPanel';
import { LogView } from './LogView';
import { PullRequestFilesStream } from './PullRequestFilesStream';
import { BranchName, ConflictBadge, PullRequestCommitList, PullRequestFileList, PullRequestPanel, StateBadge } from './PullRequestPanel';
import { PullRequestSummary } from './PullRequestSummary';
import { useCheckCounts, type CheckCounts } from '../github/use-check-counts';
import { ResizeHandle, usePanelWidth } from './ResizeHandle';
import { openLink } from '../links';
import { CopyButton } from './CopyButton';
import { HelmLoader } from './HelmLoader';
import { FileExplorer } from './FileExplorer';
import { ErrorBanner } from './ErrorBanner';
import { CheckoutMessage, ReviewCodeView, type CodeLocation } from './ReviewCodeView';
import { reviewCheckouts, useReviewCheckout } from '../github/review-checkout-store';
import { lspBridge } from '../lsp/bridge';
import { documents } from '../editor/documents';
import { moveTabFocus } from '../tablist';
import { PullRepoDialog } from './PullRepoDialog';

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
    error?: string;
    onRefresh(): Promise<void>;
    /** Shows the list of pull requests again. */
    onBack(): void;
    /** A tab to show, for example from the Dashboard. A new `nonce` shows it again. */
    tabRequest?: { tab: ReviewTab; nonce: number };
    /** Opens the New worktree dialog on the head branch of the pull request. Without it, the button does not show. */
    onNewWorktree?(pr: PullRequest): void;
    /** The projects. Undefined while they load. */
    projects?: ProjectsState;
    /** Adds the repository to a project. Without it, the "Pull into project" button does not show. */
    onPullRepo?(target: PullRepoTarget): Promise<boolean>;
}

/**
 * True when a project has a clone of the repository, false when no project has one. Undefined while the check runs.
 * The check runs again when the projects change.
 */
function useRepoInProject(repo: RepoRef, projects: ProjectsState | undefined): boolean | undefined {
    const [inProject, setInProject] = useState<boolean>();
    useEffect(() => {
        if (!projects) return;
        let current = true;
        window.shipwarden.projects.findRepo(repo).then(
            root => current && setInProject(root !== null),
            () => current && setInProject(undefined)
        );
        return () => {
            current = false;
        };
    }, [repo, projects]);
    return inProject;
}

/** The last tab request that the view applied. A remount must not apply an old request again. */
let appliedTabRequest = 0;

function readTab(): ReviewTab {
    try {
        const value = localStorage.getItem(TAB_KEY);
        return value === 'commits' || value === 'checks' || value === 'files' ? value : 'overview';
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

/** The count of the Checks tab. Its color shows the result of the checks. */
function CheckTabCount({ total, counts }: { total: number; counts: CheckCounts | undefined }) {
    if (!counts || counts.total === 0) return <span className="pr-tab-count">{total}</span>;
    if (counts.failed > 0)
        return (
            <span className="pr-tab-count failure" title={`${counts.failed} failed`}>
                {counts.total} <X size={11} strokeWidth={2.4} />
            </span>
        );
    if (counts.running > 0)
        return (
            <span className="pr-tab-count pending" title={`${counts.running} running`}>
                {counts.total}
            </span>
        );
    return (
        <span className="pr-tab-count success" title="All checks passed">
            {counts.total} <Check size={11} strokeWidth={2.4} />
        </span>
    );
}

/**
 * A pull request in the Review view, with the tabs of GitHub: Overview, Commits, Checks and Files changed.
 * The tab stays the same when the user opens a different pull request.
 */
export function ReviewPullRequest({ repo, status, pr, loading, error, onRefresh, onBack, tabRequest, onNewWorktree, projects, onPullRepo }: Props) {
    const [tab, setTab] = useState<ReviewTab>(readTab);
    const inProject = useRepoInProject(repo, projects);
    const [pullOpen, setPullOpen] = useState(false);
    const [file, setFile] = useState<{ file: PullRequestFile; line?: number; nonce: number }>();
    const [check, setCheck] = useState<CheckRun>();
    const [fileError, setFileError] = useState<string>();
    const [findRequest, setFindRequest] = useState<number>();
    const review = useReviewState(repo, pr?.number);
    const checkCounts = useCheckCounts(repo, status?.sha, status);
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
        setTab(value);
        // The Files changed tab opens the search bar again only after a new ⌘F.
        if (value !== 'files') setFindRequest(undefined);
        try {
            localStorage.setItem(TAB_KEY, value);
        } catch {
            // The tab stays for this session only.
        }
    };

    // biome-ignore lint/correctness/useExhaustiveDependencies: Each new nonce is one tab request. selectTab uses only state setters, so an old copy is correct.
    useEffect(() => {
        if (tabRequest && tabRequest.nonce !== appliedTabRequest) {
            appliedTabRequest = tabRequest.nonce;
            selectTab(tabRequest.tab);
        }
    }, [tabRequest?.nonce]);

    // ⌘F searches the changed files. The capture phase gets the key before a comment box can stop it.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The listener attaches one time. selectTab uses only state setters, so the first copy is correct.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
                event.preventDefault();
                selectTab('files');
                setFindRequest(Date.now());
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
        <button className="review-back" title="Show all pull requests" onClick={onBack}>
            <ArrowLeft size={14} strokeWidth={1.6} /> {repo.owner}/{repo.name}
        </button>
    );

    if (!pr) {
        return (
            <div className="review-pr">
                <header className="review-pr-header">{back}</header>
                {!error && loading ? <HelmLoader label="Loading the pull request" /> : <div className="review-placeholder panel-message">{error ?? ''}</div>}
            </div>
        );
    }

    const openFile = (target: PullRequestFile, line?: number) => {
        setFile({ file: target, line, nonce: Date.now() });
        selectTab('files');
    };
    const current = file && files?.find(item => item.path === file.file.path);
    const style = { '--review-side-width': `${sideWidth.width}px` } as CSSProperties;
    const sideMax = () => (document.querySelector<HTMLElement>('.pr-tab-body')?.offsetWidth ?? Infinity) - 320;
    /** The code pane leaves space for the file list and for a narrow diff. */
    const codeMax = () => (document.querySelector<HTMLElement>('.pr-tab-body')?.offsetWidth ?? Infinity) - (fileListOpen ? sideWidth.width : 0) - 320;

    return (
        <div className="review-pr">
            <header className="review-pr-header">
                {back}
                <div className="review-pr-title">
                    <h2>
                        {pr.title} <span className="review-pr-number">#{pr.number}</span>
                    </h2>
                    <div className="review-pr-actions">
                        {onPullRepo && inProject === false && (
                            <button
                                className="button"
                                title={`No project has a clone of ${repo.owner}/${repo.name}. Clone it and add it to a project.`}
                                onClick={() => setPullOpen(true)}
                            >
                                <FolderInput size={14} strokeWidth={1.6} /> Pull into project
                            </button>
                        )}
                        {onNewWorktree && (
                            <button
                                className="icon-button"
                                title={
                                    pr.isCrossRepository
                                        ? `The branch ${pr.headRefName} is in a fork. ShipWarden can make a worktree only from a branch of origin.`
                                        : `Make a worktree from the branch ${pr.headRefName}`
                                }
                                disabled={pr.isCrossRepository}
                                onClick={() => onNewWorktree(pr)}
                            >
                                <FolderGit2 size={15} strokeWidth={1.6} />
                            </button>
                        )}
                        <CopyButton text={pr.url} title="Copy the pull request URL" />
                        <button className="icon-button" title="Open on GitHub" onClick={event => openLink(pr.url, event)}>
                            <ExternalLink size={15} strokeWidth={1.6} />
                        </button>
                        <button className="icon-button" title="Refresh" onClick={() => onRefresh()}>
                            <RefreshCw size={15} strokeWidth={1.6} className={loading ? 'spin' : ''} />
                        </button>
                    </div>
                </div>
                <div className="review-pr-meta">
                    <StateBadge pr={pr} />
                    <ConflictBadge pr={pr} />
                    <span className="review-pr-summary">
                        <strong>{pr.author?.login ?? 'unknown'}</strong>{' '}
                        {pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'wanted to merge' : 'wants to merge'} {pr.commitCount} commit
                        {pr.commitCount === 1 ? '' : 's'} into <code>{pr.baseRefName}</code> from <BranchName name={pr.headRefName} />
                        <span className="dot-separator">·</span>
                        {timeAgo(pr.createdAt)}
                    </span>
                </div>
                {agentReview && (
                    <div className={`agent-review-status ${agentReview.status}`}>
                        {agentReview.status === 'running' && (
                            <>
                                <LoaderCircle size={13} className="spin" />
                                <span>The agent reviews the changes. This can take a few minutes.</span>
                                <button className="link-button" onClick={() => reviewStore.cancelAgentReview(repo, pr.number)}>
                                    Cancel
                                </button>
                            </>
                        )}
                        {agentReview.status === 'done' && (
                            <>
                                <Bot size={13} strokeWidth={1.6} />
                                <span>
                                    {agentReview.agent} added {agentReview.comments} pending comment{agentReview.comments === 1 ? '' : 's'} and a summary to
                                    your review
                                    {agentReview.notes
                                        ? ` (with ${agentReview.notes} note${agentReview.notes === 1 ? '' : 's'} that are not on a changed line)`
                                        : ''}
                                    . Accept or remove each comment, then submit the review as yourself.
                                </span>
                                <button className="link-button" onClick={() => selectTab('files')}>
                                    Show comments
                                </button>
                                <button className="link-button" onClick={() => selectTab('overview')}>
                                    Show summary
                                </button>
                            </>
                        )}
                        {agentReview.status === 'error' && <span className="agent-review-error">The agent review failed: {agentReview.error}</span>}
                        {agentReview.status !== 'running' && (
                            <button className="icon-button" title="Close" onClick={() => reviewStore.dismissAgentReview(repo, pr.number)}>
                                <X size={13} />
                            </button>
                        )}
                    </div>
                )}
                <PullRequestSummary pr={pr} checks={checkCounts} onSelectTab={selectTab} />
            </header>
            {pullOpen && onPullRepo && projects && (
                <PullRepoDialog repo={repo} projects={projects.projects} activeId={projects.activeId} onClose={() => setPullOpen(false)} onPull={onPullRepo} />
            )}

            <nav className="pr-tabs" role="tablist">
                <Tab id="overview" current={tab} onSelect={selectTab} label="Overview" />
                <Tab id="commits" current={tab} onSelect={selectTab} label="Commits" count={<span className="pr-tab-count">{pr.commitCount}</span>} />
                <Tab id="checks" current={tab} onSelect={selectTab} label="Checks" count={<CheckTabCount total={pr.checkCount} counts={checkCounts} />} />
                <Tab id="files" current={tab} onSelect={selectTab} label="Files changed" count={<span className="pr-tab-count">{pr.changedFiles}</span>} />
                <span className="pr-tabs-spacer" />
                {tab !== 'overview' && review.pending.length > 0 && pr.state === 'OPEN' && (
                    <button className="button primary pr-finish" onClick={() => selectTab('overview')}>
                        Finish review <span className="pr-tab-count">{review.pending.length}</span>
                    </button>
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
                            onOpenDiff={(_pr, target, line) => openFile(target, line)}
                            checks={checkCounts}
                            agentReview={{
                                running: agentReview?.status === 'running',
                                run: () => void reviewStore.runAgentReview(repo, pr)
                            }}
                        />
                    </div>
                )}

                {tab === 'commits' && (
                    <div className="pr-commits">
                        <PullRequestCommitList pr={pr} />
                    </div>
                )}

                {tab === 'checks' && (
                    <>
                        <div className="pr-side">
                            <ChecksPanel key={`${repo.owner}/${repo.name}#${pr.number}`} target={repo} status={status} onOpenLog={setCheck} />
                        </div>
                        <ResizeHandle panel={sideWidth} edge="right" label="Resize the check list" maxAvailable={sideMax} />
                        <div className="review-content">
                            {check ? (
                                <LogView key={check.id} target={repo} check={check} />
                            ) : (
                                <div className="panel-message">Select a check to read its log.</div>
                            )}
                        </div>
                    </>
                )}

                {tab === 'files' && (
                    <>
                        {fileListOpen && (
                            <>
                                <div className={`pr-side ${fileSide === 'all' ? 'pr-all-files' : 'pr-file-side'}`}>
                                    <div className="segmented compact pr-file-side-switch" role="radiogroup" aria-label="Files">
                                        <button
                                            role="radio"
                                            aria-checked={fileSide === 'changed'}
                                            className={fileSide === 'changed' ? 'selected' : ''}
                                            onClick={() => changeFileSide('changed')}
                                        >
                                            Changed
                                        </button>
                                        <button
                                            role="radio"
                                            aria-checked={fileSide === 'all'}
                                            className={fileSide === 'all' ? 'selected' : ''}
                                            onClick={() => changeFileSide('all')}
                                        >
                                            All files
                                        </button>
                                    </div>
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
                                    scrollTo={file && { path: file.file.path, nonce: file.nonce }}
                                    findRequest={findRequest}
                                    fileList={{ open: fileListOpen, toggle: toggleFileList }}
                                    onRefresh={onRefresh}
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
