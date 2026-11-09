import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowLeft, Bot, ClipboardCheck, ExternalLink, FileDiff, GitCommitHorizontal, ListTodo, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { BranchStatus, CheckRun, PullRequest, PullRequestFile, RepoRef } from '@shared/github';
import { reviewStore, useReviewState } from '../github/review-store';
import { errorText, timeAgo } from '../util';
import { ChecksPanel } from './ChecksPanel';
import { LogView } from './LogView';
import { PullRequestFilesStream } from './PullRequestFilesStream';
import { ConflictBadge, PullRequestCommitList, PullRequestFileList, PullRequestPanel, reviewText, StateBadge } from './PullRequestPanel';
import { ResizeHandle, usePanelWidth } from './ResizeHandle';
import { openLink } from '../links';
import { CopyButton } from './CopyButton';

export type ReviewTab = 'overview' | 'commits' | 'checks' | 'files';

const TAB_KEY = 'shipwarden.reviewTab';
const FILE_LIST_KEY = 'shipwarden.reviewFileList';

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

function Tab({ id, current, icon, label, count, onSelect }: { id: ReviewTab; current: ReviewTab; icon: ReactNode; label: string; count?: number; onSelect(id: ReviewTab): void }) {
    return (
        <button role="tab" aria-selected={id === current} className={`pr-tab${id === current ? ' selected' : ''}`} onClick={() => onSelect(id)}>
            {icon}
            <span>{label}</span>
            {count !== undefined && <span className="pr-tab-count">{count}</span>}
        </button>
    );
}

/**
 * A pull request in the Review view, with the tabs of GitHub: Overview, Commits, Checks and Files changed.
 * The tab stays the same when the user opens a different pull request.
 */
export function ReviewPullRequest({ repo, status, pr, loading, error, onRefresh, onBack, tabRequest }: Props) {
    const [tab, setTab] = useState<ReviewTab>(readTab);
    const [file, setFile] = useState<{ file: PullRequestFile; line?: number; nonce: number }>();
    const [check, setCheck] = useState<CheckRun>();
    const [fileError, setFileError] = useState<string>();
    const [findRequest, setFindRequest] = useState<number>();
    const review = useReviewState(repo, pr?.number);
    const sideWidth = usePanelWidth('shipwarden.width.reviewSide', 320, 220, 560);
    const [fileListOpen, setFileListOpen] = useState(readFileListOpen);

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

    useEffect(() => {
        if (tabRequest && tabRequest.nonce !== appliedTabRequest) {
            appliedTabRequest = tabRequest.nonce;
            selectTab(tabRequest.tab);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabRequest?.nonce]);

    // ⌘F searches the changed files. The capture phase gets the key before a comment box can stop it.
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // A different pull request starts with no file and no log.
    useEffect(() => {
        setFile(undefined);
        setCheck(undefined);
        setFileError(undefined);
    }, [repo.owner, repo.name, pr?.number]);

    useEffect(() => {
        if (pr) {
            reviewStore.loadFiles(repo, pr.number).catch(err => setFileError(errorText(err)));
        }
    }, [repo, pr?.number, pr?.headRefOid]);

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
                <div className="review-placeholder panel-message">{error ?? (loading ? 'Loading the pull request…' : '')}</div>
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

    return (
        <div className="review-pr">
            <header className="review-pr-header">
                {back}
                <div className="review-pr-title">
                    <h2>{pr.title} <span className="review-pr-number">#{pr.number}</span></h2>
                    <CopyButton text={pr.url} title="Copy the pull request URL" />
                    <button className="icon-button" title="Open on GitHub" onClick={event => openLink(pr.url, event)}>
                        <ExternalLink size={14} strokeWidth={1.6} />
                    </button>
                    <button className="icon-button" title="Refresh" onClick={() => onRefresh()}>
                        <RefreshCw size={14} strokeWidth={1.6} className={loading ? 'spin' : ''} />
                    </button>
                    {pr.state === 'OPEN' && (
                        <button
                            className="button agent-review-button"
                            title="An agent reviews the changes. You accept or remove each of its comments. Nothing goes to GitHub until you submit the review."
                            disabled={agentReview?.status === 'running'}
                            onClick={() => void reviewStore.runAgentReview(repo, pr)}
                        >
                            <Bot size={14} strokeWidth={1.6} /> Agent review
                        </button>
                    )}
                </div>
                <div className="review-pr-meta">
                    <StateBadge pr={pr} />
                    <ConflictBadge pr={pr} />
                    <span className="review-pr-summary">
                        <strong>{pr.author?.login ?? 'unknown'}</strong> {pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'wanted to merge' : 'wants to merge'}
                        {' '}{pr.commitCount} commit{pr.commitCount === 1 ? '' : 's'} into <code>{pr.baseRefName}</code> from <code>{pr.headRefName}</code>
                        <span className="dot-separator">·</span>{reviewText(pr)}
                        <span className="dot-separator">·</span>{timeAgo(pr.createdAt)}
                    </span>
                </div>
                {agentReview && (
                    <div className={`agent-review-status ${agentReview.status}`}>
                        {agentReview.status === 'running' && (
                            <>
                                <LoaderCircle size={13} className="spin" />
                                <span>The agent reviews the changes. This can take some minutes.</span>
                                <button className="link-button" onClick={() => reviewStore.cancelAgentReview(repo, pr.number)}>Cancel</button>
                            </>
                        )}
                        {agentReview.status === 'done' && (
                            <>
                                <Bot size={13} strokeWidth={1.6} />
                                <span>
                                    {agentReview.agent} added {agentReview.comments} pending comment{agentReview.comments === 1 ? '' : 's'}
                                    {' '}and a summary to your review{agentReview.notes ? ` (with ${agentReview.notes} note${agentReview.notes === 1 ? '' : 's'} that are not on a changed line)` : ''}.
                                    {' '}Accept or remove each comment, then submit the review as yourself.
                                </span>
                                <button className="link-button" onClick={() => selectTab('files')}>Show comments</button>
                                <button className="link-button" onClick={() => selectTab('overview')}>Show summary</button>
                            </>
                        )}
                        {agentReview.status === 'error' && <span className="agent-review-error">The agent review failed: {agentReview.error}</span>}
                        {agentReview.status !== 'running' && (
                            <button className="icon-button" title="Close" onClick={() => reviewStore.dismissAgentReview(repo, pr.number)}><X size={13} /></button>
                        )}
                    </div>
                )}
            </header>

            <nav className="pr-tabs" role="tablist">
                <Tab id="overview" current={tab} onSelect={selectTab} icon={<ListTodo size={16} strokeWidth={1.6} />} label="Overview" />
                <Tab id="commits" current={tab} onSelect={selectTab} icon={<GitCommitHorizontal size={16} strokeWidth={1.6} />} label="Commits" count={pr.commitCount} />
                <Tab id="checks" current={tab} onSelect={selectTab} icon={<ClipboardCheck size={16} strokeWidth={1.6} />} label="Checks" count={pr.checkCount} />
                <Tab id="files" current={tab} onSelect={selectTab} icon={<FileDiff size={16} strokeWidth={1.6} />} label="Files changed" count={pr.changedFiles} />
                <span className="pr-tabs-spacer" />
                <span className="pr-tabs-diffstat">
                    <span className="additions">+{pr.additions}</span> <span className="deletions">−{pr.deletions}</span>
                </span>
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
                            {check
                                ? <LogView key={check.id} target={repo} check={check} />
                                : <div className="panel-message">Select a check to read its log.</div>}
                        </div>
                    </>
                )}

                {tab === 'files' && (
                    <>
                        {fileListOpen && (
                            <>
                                <div className="pr-side pr-file-side">
                                    {fileError && <div className="form-error">{fileError}</div>}
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
                                </div>
                                <ResizeHandle panel={sideWidth} edge="right" label="Resize the file list" maxAvailable={sideMax} />
                            </>
                        )}
                        <div className="review-content">
                            {/* Without the file list, the error shows above the diffs. A click removes it. */}
                            {!fileListOpen && fileError && <div className="error-banner" onClick={() => setFileError(undefined)}>{fileError}</div>}
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
                                />
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
