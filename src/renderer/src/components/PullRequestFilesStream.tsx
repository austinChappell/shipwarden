import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MultiFileDiff, PatchDiff, Virtualizer, type DiffLineAnnotation, type FileDiffOptions } from '@pierre/diffs/react';
import { ChevronRight, ExternalLink, LoaderCircle, MessageSquare } from 'lucide-react';
import type { DiffSide, FileVersions, PendingComment, PullRequest, PullRequestFile, RepoTarget, ReviewThread } from '@shared/github';
import { unifiedPatch } from '@shared/patch';
import { reviewStore, useReviewState } from '../github/review-store';
import { errorText } from '../util';
import { ComposerZone, PendingZone, ThreadZone } from './DiffView';

export const STYLE_KEY = 'shipwarden.diffStyle';

export type DiffStyle = 'unified' | 'split';

/**
 * Colors of the app theme for the diff. The diff is in a shadow root, but the app variables go into it.
 * The highlight theme sets its background on the element, so these rules need "!important".
 */
export const THEME_CSS = `
:host {
    --diffs-dark-bg: var(--bg) !important;
    --diffs-light-bg: var(--bg) !important;
    --diffs-bg-context-override: var(--bg);
    --diffs-bg-context-gutter-override: var(--bg);
    --diffs-bg-separator-override: var(--panel);
    --diffs-bg-buffer-override: var(--panel);
}
[data-line-annotation], [data-gutter-buffer=annotation] {
    --diffs-annotation-bg: var(--bg);
}
`;

/** What an annotation under a diff line shows: a review thread, a pending comment, or the box for a new comment. */
type Note =
    | { kind: 'thread'; thread: ReviewThread }
    | { kind: 'pending'; comment: PendingComment }
    | { kind: 'composer'; line: number; side: DiffSide };

interface Props {
    target: RepoTarget;
    pr: PullRequest;
    files: PullRequestFile[] | undefined;
    /** A file to show: it opens and scrolls into view. A new `nonce` does it again. */
    scrollTo?: { path: string; nonce: number };
    onRefresh(): Promise<void>;
    onError(message: string): void;
}

export function readStyle(): DiffStyle {
    try {
        return localStorage.getItem(STYLE_KEY) === 'split' ? 'split' : 'unified';
    } catch {
        return 'unified';
    }
}

/** The color mode of the app ("light" or "dark"), from the root element. */
export function useColorMode(): 'light' | 'dark' {
    const read = (): 'light' | 'dark' => (document.documentElement.dataset.mode === 'light' ? 'light' : 'dark');
    const [mode, setMode] = useState(read);
    useEffect(() => {
        const observer = new MutationObserver(() => setMode(read()));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
        return () => observer.disconnect();
    }, []);
    return mode;
}

const toSide = (side: DiffSide): 'deletions' | 'additions' => (side === 'LEFT' ? 'deletions' : 'additions');
const fromSide = (side: 'deletions' | 'additions' | undefined): DiffSide => (side === 'deletions' ? 'LEFT' : 'RIGHT');

interface FileBodyProps {
    target: RepoTarget;
    pr: PullRequest;
    file: PullRequestFile;
    pending: PendingComment[];
    composer: { line: number; side: DiffSide } | undefined;
    diffStyle: DiffStyle;
    mode: 'light' | 'dark';
    onComposer(composer: { line: number; side: DiffSide } | undefined): void;
    onRefresh(): Promise<void>;
}

/**
 * The diff of one file, with the review threads, the pending comments and the comment box under their lines.
 * The "+" in the gutter starts a comment. GitHub's patch is enough for most files. Without it (a large file),
 * the view loads both versions of the file.
 */
const FileBody = memo(function FileBody({ target, pr, file, pending, composer, diffStyle, mode, onComposer, onRefresh }: FileBodyProps) {
    const patch = useMemo(() => unifiedPatch(file), [file]);
    const [versions, setVersions] = useState<FileVersions | 'error'>();
    const canComment = pr.state === 'OPEN';

    useEffect(() => {
        if (patch) return;
        let current = true;
        reviewStore.fileVersions(target, file, pr.baseRefOid, pr.headRefOid).then(
            result => current && setVersions(result),
            () => current && setVersions('error')
        );
        return () => {
            current = false;
        };
    }, [patch, target, file, pr.baseRefOid, pr.headRefOid]);

    const annotations = useMemo(() => {
        const list: DiffLineAnnotation<Note>[] = [];
        for (const thread of pr.threads) {
            if (thread.path !== file.path) continue;
            // An outdated thread has no line in the current diff. It shows above the first line.
            list.push({ side: toSide(thread.side), lineNumber: thread.line ?? 0, metadata: { kind: 'thread', thread } });
        }
        for (const comment of pending) {
            list.push({ side: toSide(comment.side), lineNumber: comment.line, metadata: { kind: 'pending', comment } });
        }
        if (composer) {
            list.push({ side: toSide(composer.side), lineNumber: composer.line, metadata: { kind: 'composer', ...composer } });
        }
        return list;
    }, [pr.threads, file.path, pending, composer]);

    const options = useMemo((): FileDiffOptions<Note, undefined> => ({
        diffStyle,
        themeType: mode,
        disableFileHeader: true,
        unsafeCSS: THEME_CSS,
        overflow: 'wrap',
        lineDiffType: 'word',
        enableGutterUtility: canComment,
        onGutterUtilityClick: range => onComposer({ line: range.end, side: fromSide(range.endSide ?? range.side) })
    }), [diffStyle, mode, canComment, onComposer]);

    const renderAnnotation = (annotation: DiffLineAnnotation<Note>): ReactNode => {
        const note = annotation.metadata;
        // Keys in a comment box must not go to the diff.
        const stop = (event: React.KeyboardEvent) => event.stopPropagation();
        if (note.kind === 'thread') {
            const thread = note.thread;
            return (
                <div className="stream-zone" onKeyDown={stop}>
                    {thread.line === null && <div className="stream-zone-note">Outdated: line {thread.originalLine ?? '?'} of an older commit</div>}
                    <ThreadZone
                        thread={thread}
                        onReply={async body => {
                            await window.shipwarden.github.reply(target, pr.number, thread.comments[thread.comments.length - 1].databaseId, body);
                            await onRefresh();
                        }}
                        onResolve={async () => {
                            await window.shipwarden.github.setThreadResolved(thread.id, !thread.isResolved);
                            await onRefresh();
                        }}
                    />
                </div>
            );
        }
        if (note.kind === 'pending') {
            return <div className="stream-zone"><PendingZone comment={note.comment} onRemove={() => reviewStore.removePending(target, pr.number, note.comment)} /></div>;
        }
        return (
            <div className="stream-zone" onKeyDown={stop}>
                <ComposerZone
                    line={note.line}
                    onCancel={() => onComposer(undefined)}
                    onAdd={body => {
                        reviewStore.addPending(target, pr.number, { path: file.path, line: note.line, side: note.side, body });
                        onComposer(undefined);
                    }}
                />
            </div>
        );
    };

    if (patch) {
        return <PatchDiff<Note, undefined> patch={patch} options={options} lineAnnotations={annotations} renderAnnotation={renderAnnotation} />;
    }
    if (!versions) {
        return <div className="stream-file-note"><LoaderCircle size={13} className="spin" /> GitHub sent no patch for this large file. Loading both versions…</div>;
    }
    if (versions === 'error') {
        return (
            <div className="stream-file-note">
                ShipWarden cannot show this file. It is possibly binary or too large.
                <button className="link-button" onClick={() => window.shipwarden.github.openInBrowser(`${pr.url}/files`)}>Open on GitHub <ExternalLink size={12} /></button>
            </div>
        );
    }
    return (
        <MultiFileDiff<Note, undefined>
            oldFile={{ name: file.previousPath ?? file.path, contents: versions.base }}
            newFile={{ name: file.path, contents: versions.head }}
            options={options}
            lineAnnotations={annotations}
            renderAnnotation={renderAnnotation}
        />
    );
});

/**
 * All changed files of a pull request in one stream, like the "Files changed" page of GitHub. Each file can collapse.
 * A file that the user marks as viewed collapses, and viewed files start collapsed.
 */
export function PullRequestFilesStream({ target, pr, files, scrollTo, onRefresh, onError }: Props) {
    const review = useReviewState(target, pr.number);
    const mode = useColorMode();
    const [diffStyle, setDiffStyle] = useState<DiffStyle>(readStyle);
    /** The open state of each file, by path. A file without an entry is open unless it is viewed. */
    const [open, setOpen] = useState<Record<string, boolean>>({});
    const [composer, setComposer] = useState<{ path: string; line: number; side: DiffSide }>();
    const sections = useRef(new Map<string, HTMLElement>());

    // A different pull request starts with the default open state.
    useEffect(() => {
        setOpen({});
        setComposer(undefined);
    }, [pr.number]);

    const isOpen = (file: PullRequestFile) => open[file.path] ?? !file.viewed;

    useEffect(() => {
        if (!scrollTo) return;
        setOpen(map => ({ ...map, [scrollTo.path]: true }));
        requestAnimationFrame(() => sections.current.get(scrollTo.path)?.scrollIntoView({ block: 'start' }));
    }, [scrollTo?.nonce]);

    const changeStyle = (value: DiffStyle) => {
        setDiffStyle(value);
        try {
            localStorage.setItem(STYLE_KEY, value);
        } catch {
            // The choice stays for this session only.
        }
    };

    /** Marks a file as viewed (it collapses) or not viewed (it opens), on GitHub. */
    const setViewed = (file: PullRequestFile, viewed: boolean) => {
        setOpen(map => ({ ...map, [file.path]: !viewed }));
        reviewStore.setViewed(target, pr.number, pr.id, file.path, viewed).catch(err => onError(errorText(err)));
        if (viewed) {
            // The next file comes to the top, so the review goes on from there.
            requestAnimationFrame(() => sections.current.get(file.path)?.scrollIntoView({ block: 'nearest' }));
        }
    };

    const commentCount = (path: string) =>
        pr.threads.filter(thread => thread.path === path && !thread.isResolved).length + review.pending.filter(comment => comment.path === path).length;

    if (!files) {
        return <div className="panel-message"><LoaderCircle size={14} className="spin" /> Loading the changed files…</div>;
    }
    const viewedCount = files.filter(file => file.viewed).length;

    return (
        <div className="files-stream">
            <div className="files-stream-toolbar">
                <span className="files-stream-count">{viewedCount} of {files.length} viewed</span>
                <span className="header-spacer" />
                <button className="link-button" onClick={() => setOpen(Object.fromEntries(files.map(file => [file.path, false])))}>Collapse all</button>
                <button className="link-button" onClick={() => setOpen(Object.fromEntries(files.map(file => [file.path, true])))}>Expand all</button>
                <div className="segmented compact" role="radiogroup" aria-label="Diff layout">
                    <button className={diffStyle === 'unified' ? 'selected' : ''} onClick={() => changeStyle('unified')}>Unified</button>
                    <button className={diffStyle === 'split' ? 'selected' : ''} onClick={() => changeStyle('split')}>Split</button>
                </div>
            </div>
            <Virtualizer className="files-stream-scroll" contentClassName="files-stream-content">
                {files.map(file => {
                    const expanded = isOpen(file);
                    const count = commentCount(file.path);
                    return (
                        <section
                            key={file.path}
                            className={`stream-file${expanded ? ' open' : ''}${file.viewed ? ' viewed' : ''}`}
                            ref={element => {
                                if (element) sections.current.set(file.path, element);
                                else sections.current.delete(file.path);
                            }}
                        >
                            <header className="stream-file-header" onClick={() => setOpen(map => ({ ...map, [file.path]: !expanded }))}>
                                <ChevronRight size={14} strokeWidth={1.8} className={`group-chevron${expanded ? ' open' : ''}`} />
                                <span className={`file-status status-${file.status}`}>{file.status[0].toUpperCase()}</span>
                                <span className="stream-file-path" title={file.path}>
                                    {file.previousPath && file.previousPath !== file.path ? `${file.previousPath} → ` : ''}{file.path}
                                </span>
                                {count > 0 && <span className="comment-count"><MessageSquare size={12} strokeWidth={1.6} />{count}</span>}
                                <span className="additions">+{file.additions}</span>
                                <span className="deletions">−{file.deletions}</span>
                                <label className="viewed-toggle" title="Mark the file as viewed, as on GitHub" onClick={event => event.stopPropagation()}>
                                    <input type="checkbox" checked={!!file.viewed} onChange={event => setViewed(file, event.target.checked)} />
                                    Viewed
                                </label>
                            </header>
                            {expanded && (
                                <FileBody
                                    target={target}
                                    pr={pr}
                                    file={file}
                                    pending={review.pending.filter(comment => comment.path === file.path)}
                                    composer={composer?.path === file.path ? composer : undefined}
                                    diffStyle={diffStyle}
                                    mode={mode}
                                    onComposer={next => setComposer(next ? { ...next, path: file.path } : undefined)}
                                    onRefresh={onRefresh}
                                />
                            )}
                        </section>
                    );
                })}
            </Virtualizer>
        </div>
    );
}
