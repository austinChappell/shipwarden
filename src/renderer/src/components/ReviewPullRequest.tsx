import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { ClipboardCheck, ExternalLink, FileDiff, GitCommitHorizontal, ListTodo, RefreshCw } from 'lucide-react';
import type { BranchStatus, CheckRun, PullRequest, PullRequestFile, RepoRef } from '@shared/github';
import { reviewStore, useReviewState } from '../github/review-store';
import { errorText, timeAgo } from '../util';
import { ChecksPanel } from './ChecksPanel';
import { LogView } from './LogView';
import { PullRequestFilesStream } from './PullRequestFilesStream';
import { PullRequestFileList, PullRequestPanel, reviewText, StateBadge } from './PullRequestPanel';
import { ResizeHandle, usePanelWidth } from './ResizeHandle';

export type ReviewTab = 'overview' | 'commits' | 'checks' | 'files';

const TAB_KEY = 'shipwarden.reviewTab';

interface Props {
    repo: RepoRef;
    /** The branch status from the pull request. Undefined while it loads. */
    status: BranchStatus | undefined;
    pr: PullRequest | undefined;
    loading: boolean;
    error?: string;
    onRefresh(): Promise<void>;
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
export function ReviewPullRequest({ repo, status, pr, loading, error, onRefresh, tabRequest }: Props) {
    const [tab, setTab] = useState<ReviewTab>(readTab);
    const [file, setFile] = useState<{ file: PullRequestFile; line?: number; nonce: number }>();
    const [check, setCheck] = useState<CheckRun>();
    const [fileError, setFileError] = useState<string>();
    const review = useReviewState(repo, pr?.number);
    const sideWidth = usePanelWidth('shipwarden.width.reviewSide', 320, 220, 560);

    const selectTab = (value: ReviewTab) => {
        setTab(value);
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

    if (!pr) {
        return <div className="review-placeholder panel-message">{error ?? (loading ? 'Loading the pull request…' : '')}</div>;
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
                <div className="review-pr-title">
                    <h2>{pr.title} <span className="review-pr-number">#{pr.number}</span></h2>
                    <button className="icon-button" title="Open on GitHub" onClick={() => window.shipwarden.github.openInBrowser(pr.url)}>
                        <ExternalLink size={14} strokeWidth={1.6} />
                    </button>
                    <button className="icon-button" title="Refresh" onClick={() => onRefresh()}>
                        <RefreshCw size={14} strokeWidth={1.6} className={loading ? 'spin' : ''} />
                    </button>
                </div>
                <div className="review-pr-meta">
                    <StateBadge pr={pr} />
                    <span className="review-pr-summary">
                        <strong>{pr.author?.login ?? 'unknown'}</strong> {pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'wanted to merge' : 'wants to merge'}
                        {' '}{pr.commitCount} commit{pr.commitCount === 1 ? '' : 's'} into <code>{pr.baseRefName}</code> from <code>{pr.headRefName}</code>
                        <span className="dot-separator">·</span>{reviewText(pr)}
                        <span className="dot-separator">·</span>{timeAgo(pr.createdAt)}
                    </span>
                </div>
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
                            canMerge={pr.viewerDidAuthor}
                        />
                    </div>
                )}

                {tab === 'commits' && (
                    <div className="pr-commits">
                        {pr.commitCount > pr.commits.length && (
                            <div className="panel-note">The list shows the newest {pr.commits.length} of {pr.commitCount} commits, the newest first.</div>
                        )}
                        <div className="pr-commit-list">
                        {[...pr.commits].reverse().map(commit => (
                            <div key={commit.oid} className="pr-commit">
                                <GitCommitHorizontal size={15} strokeWidth={1.6} className="pr-commit-icon" />
                                <div className="pr-commit-main">
                                    <div className="pr-commit-title">{commit.messageHeadline}</div>
                                    <div className="pr-commit-meta">{commit.author ?? 'unknown'} committed {timeAgo(commit.committedDate)}</div>
                                </div>
                                <button className="link-button pr-commit-sha" title="Open the commit on GitHub" onClick={() => window.shipwarden.github.openInBrowser(commit.url)}>
                                    {commit.abbreviatedOid}
                                </button>
                            </div>
                        ))}
                        </div>
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
                        <div className="review-content">
                            <PullRequestFilesStream
                                key={`${repo.owner}/${repo.name}#${pr.number}`}
                                target={repo}
                                pr={pr}
                                files={files}
                                scrollTo={file && { path: file.file.path, nonce: file.nonce }}
                                onRefresh={onRefresh}
                                onError={setFileError}
                            />
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
