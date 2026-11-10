import { useLayoutEffect, useRef, useState } from 'react';
import {
    ChevronRight,
    GitCommitHorizontal,
    GitMerge,
    GitPullRequest,
    GitPullRequestClosed,
    GitPullRequestDraft,
    MessageSquare,
    TriangleAlert
} from 'lucide-react';
import { baseName, parentPath } from '@shared/files';
import { hostLabel, type PullRequest, type PullRequestFile, type RepoTarget } from '@shared/github';
import { fileIcon } from '../files/file-icons';
import { reviewStore, useReviewState } from '../github/review-store';
import { hasConflicts } from '../github/merge-state';
import { openCommentCount } from '../github/review-state';
import { errorText, timeAgo } from '../util';
import { Markdown } from './Markdown';
import { splitFooter } from './pr-description';
import { Avatar } from './Avatar';
import { EditDescriptionButton } from './PullRequestDetails';
import { openLink } from '../links';
import { CopyButton } from './CopyButton';
import { itemKeys, moveListFocus } from '../keyboard/list-nav';

const ICON = { size: 15, strokeWidth: 1.6 };

export function StateBadge({ pr }: { pr: PullRequest }) {
    if (pr.state === 'MERGED')
        return (
            <span className="pr-badge merged">
                <GitMerge {...ICON} />
                Merged
            </span>
        );
    if (pr.state === 'CLOSED')
        return (
            <span className="pr-badge closed">
                <GitPullRequestClosed {...ICON} />
                Closed
            </span>
        );
    if (pr.isDraft)
        return (
            <span className="pr-badge draft">
                <GitPullRequestDraft {...ICON} />
                Draft
            </span>
        );
    return (
        <span className="pr-badge open">
            <GitPullRequest {...ICON} />
            Open
        </span>
    );
}

/** A branch name in code style, with a button that copies the name. */
export function BranchName({ name }: { name: string }) {
    return (
        <span className="branch-name">
            <code>{name}</code>
            <CopyButton text={name} title="Copy the branch name" size={12} className="icon-button branch-copy" />
        </span>
    );
}

/** A red badge next to the state badge when the pull request has merge conflicts. */
export function ConflictBadge({ pr }: { pr: PullRequest }) {
    if (!hasConflicts(pr)) return null;
    return (
        <span className="pr-badge conflict" title={`The branch ${pr.headRefName} has conflicts with ${pr.baseRefName}. GitHub cannot merge it.`}>
            <TriangleAlert {...ICON} />
            Merge conflicts
        </span>
    );
}

/** The commits of a pull request, the newest first, with a link to each commit on the host. */
export function PullRequestCommitList({ pr }: { pr: PullRequest }) {
    return (
        <>
            {pr.commitCount > pr.commits.length && (
                <div className="panel-note">
                    The list shows the newest {pr.commits.length} of {pr.commitCount} commits, the newest first.
                </div>
            )}
            <div className="pr-commit-list">
                {[...pr.commits].reverse().map(commit => (
                    <div key={commit.oid} className="pr-commit">
                        <GitCommitHorizontal size={15} strokeWidth={1.6} className="pr-commit-icon" />
                        <div className="pr-commit-main">
                            <div className="pr-commit-title" title={commit.messageHeadline}>
                                {commit.messageHeadline}
                            </div>
                            <div className="pr-commit-meta">
                                {commit.author ?? 'unknown'} committed {timeAgo(commit.committedDate)}
                            </div>
                        </div>
                        <button
                            className="link-button pr-commit-sha"
                            title={`Open the commit on ${hostLabel(pr.host)}`}
                            onClick={event => openLink(commit.url, event)}
                        >
                            {commit.abbreviatedOid}
                        </button>
                    </div>
                ))}
            </div>
        </>
    );
}

/**
 * The description of a pull request. In the panel, a long description shows only its start.
 * The title and the "Show more" button open the full text.
 */
export function PullRequestDescription({ pr, overview, onEdit }: { pr: PullRequest; overview: boolean; onEdit(): void }) {
    const [open, setOpen] = useState(false);
    const [overflows, setOverflows] = useState(false);
    const box = useRef<HTMLDivElement>(null);
    const body = pr.body.trim();

    // Measure the closed text. The button shows only when the text is longer than the closed height.
    // biome-ignore lint/correctness/useExhaustiveDependencies: A new description text has a new height. Thus the effect measures it again.
    useLayoutEffect(() => {
        const element = box.current;
        if (!element || open || overview) return;
        const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [pr.body, open, overview]);

    const editButton = pr.viewerCanUpdate && <EditDescriptionButton onClick={onEdit} />;
    if (overview) {
        const { text, footer } = splitFooter(body);
        const author = pr.author?.login ?? 'unknown';
        return (
            <section className="pr-section">
                <div className="pr-description-card">
                    <div className="pr-description-card-header">
                        <Avatar login={author} url={pr.author?.avatarUrl} size={24} className="pr-description-avatar" />
                        <span className="pr-description-card-title">
                            <strong>{author}</strong> opened this <span className="dot-separator">·</span>{' '}
                            <time dateTime={pr.createdAt} title={new Date(pr.createdAt).toLocaleString()}>
                                {timeAgo(pr.createdAt)}
                            </time>
                        </span>
                        {editButton}
                    </div>
                    {text ? <Markdown className="pr-description open" text={text} /> : <div className="panel-note pr-description-empty">No description.</div>}
                    {footer && <Markdown className="pr-description-card-footer" text={footer} />}
                </div>
            </section>
        );
    }
    if (!body) {
        return (
            <section className="pr-section">
                <div className="section-title">Description{editButton}</div>
                {body ? <Markdown className="pr-description open" text={pr.body} /> : <div className="panel-note">No description.</div>}
            </section>
        );
    }
    const toggleable = open || overflows;
    return (
        <section className="pr-section">
            <div className="section-title-row">
                {toggleable ? (
                    <button
                        className="section-toggle"
                        aria-expanded={open}
                        title={open ? 'Show less' : 'Show the full description'}
                        onClick={() => setOpen(value => !value)}
                    >
                        <ChevronRight size={13} strokeWidth={1.8} className={`section-chevron${open ? ' open' : ''}`} />
                        Description
                    </button>
                ) : (
                    <div className="section-title">Description</div>
                )}
                {editButton}
            </div>
            <div ref={box} className={`pr-description${open ? ' open' : ''}${!open && overflows ? ' clipped' : ''}`}>
                <Markdown text={pr.body} />
            </div>
            {toggleable && (
                <button className="link-button pr-description-more" onClick={() => setOpen(value => !value)}>
                    {open ? 'Show less' : 'Show more'}
                </button>
            )}
        </section>
    );
}

interface FileListProps {
    target: RepoTarget;
    pr: PullRequest;
    files: PullRequestFile[] | undefined;
    /** The path of the file that the diff shows, to highlight its row. */
    selectedPath?: string;
    onOpen(file: PullRequestFile): void;
    onError(message: string): void;
}

/** The changed files of a pull request, with the count of open comments and the "Viewed" box of each file. */
export function PullRequestFileList({ target, pr, files, selectedPath, onOpen, onError }: FileListProps) {
    const review = useReviewState(target, pr.number);
    const commentCount = (path: string) => openCommentCount(pr.threads, review.pending, path);
    return (
        <>
            <div className="section-title">
                Files changed {files ? `(${files.length})` : ''}
                {files && files.length > 0 && (
                    <span className="viewed-count">
                        {files.filter(item => item.viewed).length} of {files.length} viewed
                    </span>
                )}
            </div>
            {!files && <div className="panel-note">Loading files…</div>}
            <div onKeyDown={moveListFocus}>
                {files?.map(file => {
                    const Icon = fileIcon(baseName(file.path));
                    const count = commentCount(file.path);
                    return (
                        <div
                            key={file.path}
                            className={`tree-row pr-file${file.path === selectedPath ? ' selected' : ''}${file.viewed ? ' viewed' : ''}`}
                            title={file.path}
                            tabIndex={0}
                            role="button"
                            aria-label={file.path}
                            data-nav-item
                            onClick={() => onOpen(file)}
                            onKeyDown={itemKeys(() => onOpen(file))}
                        >
                            <span className={`file-status status-${file.status}`}>{file.status[0].toUpperCase()}</span>
                            <Icon className="tree-icon" size={15} strokeWidth={1.5} />
                            <span className="tree-name">{baseName(file.path)}</span>
                            <span className="tree-detail">{parentPath(file.path)}</span>
                            {count > 0 && (
                                <span className="comment-count">
                                    <MessageSquare size={12} strokeWidth={1.6} />
                                    {count}
                                </span>
                            )}
                            <span className="additions">+{file.additions}</span>
                            <span className="deletions">−{file.deletions}</span>
                            <input
                                type="checkbox"
                                className="viewed-box"
                                title={file.viewed ? 'Viewed. Click to mark as not viewed.' : 'Mark as viewed'}
                                checked={!!file.viewed}
                                onClick={event => event.stopPropagation()}
                                onChange={event =>
                                    reviewStore.setViewed(target, pr.number, pr.id, file.path, event.target.checked).catch(err => onError(errorText(err)))
                                }
                            />
                        </div>
                    );
                })}
            </div>
        </>
    );
}
