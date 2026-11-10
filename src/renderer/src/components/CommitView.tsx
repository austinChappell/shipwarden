import { memo, useEffect, useMemo, useState } from 'react';
import { MultiFileDiff, PatchDiff, Virtualizer } from '@pierre/diffs/react';
import { ArrowLeft, ChevronLeft, ChevronRight, ExternalLink, LoaderCircle } from 'lucide-react';
import { hostLabel, type FileVersions, type PullRequest, type PullRequestCommit, type PullRequestFile, type RepoTarget } from '@shared/github';
import { unifiedPatch } from '@shared/patch';
import { reviewStore, useCommitFiles } from '../github/review-store';
import { openLink } from '../links';
import { errorText, timeAgo } from '../util';
import { CopyButton } from './CopyButton';
import { readStyle, STYLE_KEY, THEME_CSS, useColorMode, type DiffStyle } from './diff-style';
import { radioGroupKeys } from './keyboard';

interface Props {
    target: RepoTarget;
    pr: PullRequest;
    commit: PullRequestCommit;
    /** Goes back to the commit list. */
    onBack(): void;
    /** Shows another commit of the pull request. */
    onSelect(commit: PullRequestCommit): void;
}

/**
 * The diff of one commit of a pull request: the changes between the commit and its first parent.
 * The view is read-only. The review comments stay on the Files changed tab, because they apply to the full pull request.
 */
export function CommitView({ target, pr, commit, onBack, onSelect }: Props) {
    const query = useCommitFiles(target, commit.oid);
    const [diffStyle, setDiffStyle] = useState<DiffStyle>(readStyle);
    const [closed, setClosed] = useState<Set<string>>(() => new Set());
    const mode = useColorMode();

    const index = pr.commits.findIndex(item => item.oid === commit.oid);
    const previous = index > 0 ? pr.commits[index - 1] : undefined;
    const next = index >= 0 && index < pr.commits.length - 1 ? pr.commits[index + 1] : undefined;

    const changeStyle = (value: DiffStyle) => {
        setDiffStyle(value);
        try {
            localStorage.setItem(STYLE_KEY, value);
        } catch {
            // The choice stays for this session only.
        }
    };
    const toggle = (path: string) =>
        setClosed(current => {
            const copy = new Set(current);
            if (copy.has(path)) copy.delete(path);
            else copy.add(path);
            return copy;
        });

    const files = query.data?.files;
    const additions = files?.reduce((sum, file) => sum + file.additions, 0) ?? 0;
    const deletions = files?.reduce((sum, file) => sum + file.deletions, 0) ?? 0;
    // Azure DevOps sends no line counts. Then the toolbar shows only the count of files.
    const hasCounts = additions + deletions > 0;

    return (
        <div className="commit-view">
            <header className="commit-view-header">
                <div className="commit-view-nav">
                    <button className="link-button commit-view-back" onClick={onBack}>
                        <ArrowLeft size={13} strokeWidth={1.8} /> All commits
                    </button>
                    <span className="header-spacer" />
                    {index >= 0 && (
                        <span className="commit-view-position">
                            Commit {index + 1} of {pr.commits.length}
                        </span>
                    )}
                    <button className="icon-button" title="Show the previous commit" disabled={!previous} onClick={() => previous && onSelect(previous)}>
                        <ChevronLeft size={15} strokeWidth={1.8} />
                    </button>
                    <button className="icon-button" title="Show the next commit" disabled={!next} onClick={() => next && onSelect(next)}>
                        <ChevronRight size={15} strokeWidth={1.8} />
                    </button>
                </div>
                <h3 className="commit-view-title">{commit.messageHeadline}</h3>
                <div className="commit-view-meta">
                    <span>
                        <strong>{commit.author ?? 'unknown'}</strong> committed{' '}
                        <time dateTime={commit.committedDate} title={new Date(commit.committedDate).toLocaleString()}>
                            {timeAgo(commit.committedDate)}
                        </time>
                    </span>
                    <span className="commit-view-sha">
                        <code>{commit.abbreviatedOid}</code>
                        <CopyButton text={commit.oid} title="Copy the full commit SHA" size={12} className="icon-button" />
                    </span>
                    <span className="header-spacer" />
                    <button className="button commit-view-external" onClick={event => openLink(commit.url, event)}>
                        Open on {hostLabel(pr.host)} <ExternalLink size={12} strokeWidth={1.8} />
                    </button>
                </div>
            </header>

            <div className="review-stream">
                <div className="files-stream">
                    <div className="files-stream-toolbar">
                        <span className="files-stream-count">
                            {files ? `${files.length} ${files.length === 1 ? 'file' : 'files'} changed` : 'Loading the files…'}
                        </span>
                        {hasCounts && (
                            <span>
                                <span className="additions">+{additions}</span> <span className="deletions">−{deletions}</span>
                            </span>
                        )}
                        <span className="header-spacer" />
                        {files && files.length > 0 && (
                            <>
                                <button className="link-button" onClick={() => setClosed(new Set(files.map(file => file.path)))}>
                                    Collapse all
                                </button>
                                <button className="link-button" onClick={() => setClosed(new Set())}>
                                    Expand all
                                </button>
                            </>
                        )}
                        <div className="segmented compact" role="radiogroup" aria-label="Diff layout" onKeyDown={radioGroupKeys}>
                            <button
                                role="radio"
                                aria-checked={diffStyle === 'unified'}
                                className={diffStyle === 'unified' ? 'selected' : ''}
                                onClick={() => changeStyle('unified')}
                            >
                                Unified
                            </button>
                            <button
                                role="radio"
                                aria-checked={diffStyle === 'split'}
                                className={diffStyle === 'split' ? 'selected' : ''}
                                onClick={() => changeStyle('split')}
                            >
                                Split
                            </button>
                        </div>
                    </div>
                    {query.error && <div className="form-error commit-view-error">{errorText(query.error)}</div>}
                    {query.isPending && (
                        <div className="panel-message">
                            <LoaderCircle size={14} className="spin" /> Loading the commit…
                        </div>
                    )}
                    {files && files.length === 0 && <div className="panel-message">This commit changes no files.</div>}
                    {files && files.length > 0 && (
                        <Virtualizer className="files-stream-scroll" contentClassName="files-stream-content">
                            {files.map(file => {
                                const expanded = !closed.has(file.path);
                                return (
                                    <section key={file.path} className={`stream-file${expanded ? ' open' : ''}`}>
                                        <header className="stream-file-header" onClick={() => toggle(file.path)}>
                                            <button className="row-toggle" aria-expanded={expanded}>
                                                <ChevronRight size={14} strokeWidth={1.8} className={`group-chevron${expanded ? ' open' : ''}`} />
                                                <span className={`file-status status-${file.status}`}>{file.status[0].toUpperCase()}</span>
                                                <span className="stream-file-path" title={file.path}>
                                                    {file.previousPath && file.previousPath !== file.path ? `${file.previousPath} → ` : ''}
                                                    {file.path}
                                                </span>
                                            </button>
                                            <CopyButton text={file.path} title="Copy the file path" size={13} className="icon-button stream-file-copy" />
                                            {(file.additions > 0 || file.deletions > 0) && (
                                                <>
                                                    <span className="additions">+{file.additions}</span>
                                                    <span className="deletions">−{file.deletions}</span>
                                                </>
                                            )}
                                        </header>
                                        {expanded && (
                                            <CommitFileBody
                                                target={target}
                                                file={file}
                                                parentSha={query.data?.parentSha ?? null}
                                                sha={commit.oid}
                                                diffStyle={diffStyle}
                                                mode={mode}
                                            />
                                        )}
                                    </section>
                                );
                            })}
                        </Virtualizer>
                    )}
                </div>
            </div>
        </div>
    );
}

interface FileBodyProps {
    target: RepoTarget;
    file: PullRequestFile;
    parentSha: string | null;
    sha: string;
    diffStyle: DiffStyle;
    mode: 'light' | 'dark';
}

/** The diff of one file of a commit. Without a patch (a large file, or Azure DevOps), it loads the two versions of the file. */
const CommitFileBody = memo(function CommitFileBody({ target, file, parentSha, sha, diffStyle, mode }: FileBodyProps) {
    const patch = useMemo(() => unifiedPatch(file), [file]);
    const [versions, setVersions] = useState<FileVersions | 'error'>();

    useEffect(() => {
        if (patch) return;
        let current = true;
        // The first commit of a repository has no parent. Then the old version of each file is empty.
        const load = parentSha
            ? reviewStore.fileVersions(target, file, parentSha, sha)
            : reviewStore.fileVersions(target, { ...file, status: 'added' }, '', sha);
        load.then(
            result => current && setVersions(result.unavailable ? 'error' : result),
            () => current && setVersions('error')
        );
        return () => {
            current = false;
        };
    }, [patch, target, file, parentSha, sha]);

    const options = useMemo(
        () => ({
            diffStyle,
            themeType: mode,
            disableFileHeader: true,
            unsafeCSS: THEME_CSS,
            overflow: 'wrap' as const,
            lineDiffType: 'word' as const,
            // The patch has only the lines near the changes. To show the hidden lines, the diff loads the two full files.
            loadDiffFiles: async () => {
                if (!parentSha) throw new Error('This commit has no parent.');
                const result = await reviewStore.fileVersions(target, file, parentSha, sha);
                if (result.unavailable) throw new Error(`The full versions of ${file.path} are not available.`);
                return {
                    oldFile: { name: file.previousPath ?? file.path, contents: result.base },
                    newFile: { name: file.path, contents: result.head }
                };
            }
        }),
        [diffStyle, mode, target, file, parentSha, sha]
    );

    if (patch) return <PatchDiff patch={patch} options={options} />;
    if (!versions) {
        return (
            <div className="stream-file-note">
                <LoaderCircle size={13} className="spin" /> Loading both versions of the file…
            </div>
        );
    }
    if (versions === 'error') {
        return <div className="stream-file-note">ShipWarden cannot show this file. It is possibly binary or too large.</div>;
    }
    return (
        <MultiFileDiff
            oldFile={{ name: file.previousPath ?? file.path, contents: versions.base }}
            newFile={{ name: file.path, contents: versions.head }}
            options={options}
        />
    );
});
