import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { MultiFileDiff } from '@pierre/diffs/react';
import { Check, Copy, History, LoaderCircle } from 'lucide-react';
import type { FileHistory, FileHistoryCommit } from '@shared/git-blame';
import type { ChangeContents } from '@shared/git';
import { onGitChanged } from '../git/git-store';
import { errorText } from '../util';
import { EmptyState } from './EmptyState';
import { DIFF_THEME, readStyle, STYLE_KEY, THEME_CSS, useColorMode, type DiffStyle } from './diff-style';
import { radioGroupKeys } from './keyboard';
import { Age, Button, ButtonGroup, RefreshButton, SkeletonRows } from './ui';

interface Props {
    root: string;
    /** The path of the file, relative to the root. */
    path: string;
    /** The commit to select. Without it, the newest commit is selected. */
    commit?: string;
}

/** The number of commits that one page of the history loads. */
const PAGE = 100;
/** The history loads more pages to find the selected commit, up to this number of commits. */
const MAX_SEARCH = 2000;

/**
 * The git history of one file: the commits that changed it, newest first, and the change of the selected commit.
 * The history follows the renames of the file. The arrow keys move the selection in the list.
 */
export function FileHistoryView({ root, path, commit }: Props) {
    const [limit, setLimit] = useState(PAGE);
    const [history, setHistory] = useState<FileHistory>();
    const [error, setError] = useState<string>();
    const [loading, setLoading] = useState(false);
    const [selected, setSelected] = useState(commit);
    const [version, setVersion] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    // A new commit from the blame column selects that commit.
    useEffect(() => setSelected(commit), [commit]);

    useEffect(() => onGitChanged(() => setVersion(value => value + 1)), []);

    // biome-ignore lint/correctness/useExhaustiveDependencies: version tells the effect to read the history again.
    useEffect(() => {
        let current = true;
        setLoading(true);
        window.shipwarden.git.fileHistory(root, path, limit).then(
            next => {
                if (!current) return;
                setHistory(next);
                setError(undefined);
                setLoading(false);
            },
            failure => {
                if (!current) return;
                setError(errorText(failure));
                setLoading(false);
            }
        );
        return () => {
            current = false;
        };
    }, [root, path, limit, version]);

    // Load more commits until the list has the selected commit.
    useEffect(() => {
        if (!history || !selected || !history.more || limit >= MAX_SEARCH) return;
        if (!history.commits.some(item => item.hash === selected)) setLimit(value => Math.min(MAX_SEARCH, value + PAGE * 5));
    }, [history, selected, limit]);

    const commits = history?.commits ?? [];
    const active = commits.find(item => item.hash === selected) ?? (history?.more && selected ? undefined : commits[0]);

    // Show the selected row when the selection changes.
    useEffect(() => {
        if (!active) return;
        listRef.current?.querySelector(`[data-hash="${active.hash}"]`)?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const index = active ? commits.indexOf(active) : -1;
        const next = commits[Math.max(0, Math.min(commits.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
        if (next) setSelected(next.hash);
    };

    if (error) {
        return (
            <div className="file-history">
                <div className="editor-failure">{error}</div>
            </div>
        );
    }
    if (!history) {
        return (
            <div className="file-history">
                <div className="file-history-list">
                    <SkeletonRows count={8} dot={false} label="Loading the history" />
                </div>
            </div>
        );
    }
    if (!commits.length) {
        return (
            <div className="file-history">
                <EmptyState icon={History} title="No history">
                    No commit changed this file. Commit the file to start its history.
                </EmptyState>
            </div>
        );
    }

    return (
        <div className="file-history">
            <div className="file-history-list" ref={listRef} role="listbox" aria-label="Commits that changed the file" tabIndex={0} onKeyDown={onKeyDown}>
                {commits.map(item => (
                    <div
                        key={item.hash}
                        data-hash={item.hash}
                        role="option"
                        aria-selected={item === active}
                        tabIndex={-1}
                        className={`file-history-row${item === active ? ' selected' : ''}`}
                        onClick={() => setSelected(item.hash)}
                        onKeyDown={onKeyDown}
                    >
                        <span className="file-history-subject" title={item.subject}>
                            {item.subject}
                        </span>
                        <span className="file-history-meta">
                            <span className="file-history-author">{item.author}</span>
                            <Age date={new Date(item.date).toISOString()} format="prose" />
                            <span className="mono">{item.hash.slice(0, 7)}</span>
                        </span>
                    </div>
                ))}
                {history.more && (
                    <Button
                        size="sm"
                        className="file-history-more"
                        disabled={loading}
                        icon={loading ? <LoaderCircle size={12} className="spin" /> : undefined}
                        onClick={() => setLimit(value => value + PAGE)}
                    >
                        Load more
                    </Button>
                )}
            </div>
            {active ? (
                <CommitChange root={root} commit={active} onReload={() => setVersion(value => value + 1)} />
            ) : (
                <div className="panel-message">
                    <LoaderCircle size={14} className="spin" /> Looking for the commit…
                </div>
            )}
        </div>
    );
}

/** The time that the copy button shows its check mark. */
const COPIED_MS = 1500;

/** The details of one commit and its change to the file. */
function CommitChange({ root, commit, onReload }: { root: string; commit: FileHistoryCommit; onReload(): void }) {
    const [contents, setContents] = useState<ChangeContents>();
    const [error, setError] = useState<string>();
    const [diffStyle, setDiffStyle] = useState<DiffStyle>(readStyle);
    const [copied, setCopied] = useState(false);
    const mode = useColorMode();

    useEffect(() => {
        let current = true;
        setContents(undefined);
        setError(undefined);
        window.shipwarden.git.commitFileContents(root, commit.hash, commit.path, commit.oldPath).then(
            next => current && setContents(next),
            failure => current && setError(errorText(failure))
        );
        return () => {
            current = false;
        };
    }, [root, commit.hash, commit.path, commit.oldPath]);

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), COPIED_MS);
        return () => clearTimeout(timer);
    }, [copied]);

    const changeStyle = (value: DiffStyle) => {
        setDiffStyle(value);
        try {
            localStorage.setItem(STYLE_KEY, value);
        } catch {
            // The choice stays for this session only.
        }
    };

    const copyHash = useCallback(() => {
        navigator.clipboard.writeText(commit.hash).then(
            () => setCopied(true),
            () => undefined
        );
    }, [commit.hash]);

    const options = useMemo(
        () => ({
            diffStyle,
            theme: DIFF_THEME,
            themeType: mode,
            disableFileHeader: true,
            overflow: 'wrap' as const,
            lineDiffType: 'word' as const,
            unsafeCSS: THEME_CSS
        }),
        [diffStyle, mode]
    );

    // The body is the message without the subject line.
    const body = commit.body.startsWith(commit.subject) ? commit.body.slice(commit.subject.length).trim() : commit.body;
    const same = contents && !contents.binary && contents.original === contents.modified;

    return (
        <div className="file-history-detail">
            <div className="file-history-commit">
                <div className="file-history-title">
                    <h3>{commit.subject}</h3>
                    <span className="header-spacer" />
                    <ButtonGroup size="sm" role="radiogroup" label="Diff layout" onKeyDown={radioGroupKeys}>
                        <Button size="sm" role="radio" aria-checked={diffStyle === 'unified'} onClick={() => changeStyle('unified')}>
                            Unified
                        </Button>
                        <Button size="sm" role="radio" aria-checked={diffStyle === 'split'} onClick={() => changeStyle('split')}>
                            Split
                        </Button>
                    </ButtonGroup>
                    <RefreshButton size="sm" onRefresh={onReload} />
                </div>
                <div className="file-history-info">
                    <span title={commit.authorEmail}>{commit.author}</span>
                    <span>{new Date(commit.date).toLocaleString()}</span>
                    <button type="button" className="file-history-hash mono" title={copied ? 'Copied' : 'Copy the commit hash'} onClick={copyHash}>
                        {commit.hash.slice(0, 8)}
                        {copied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={1.6} />}
                    </button>
                    {commit.oldPath && <span>Renamed from {commit.oldPath}</span>}
                </div>
                {body && <p className="file-history-body">{body}</p>}
            </div>
            {error && <div className="editor-failure">{error}</div>}
            {!contents && !error && (
                <div className="panel-message">
                    <LoaderCircle size={14} className="spin" /> Loading the diff…
                </div>
            )}
            {contents?.binary && <div className="panel-message">This is a binary file. ShipWarden does not show its diff.</div>}
            {same && <div className="panel-message">This commit did not change the text of the file.</div>}
            {contents && !contents.binary && !same && (
                <div className="change-diff-body">
                    <MultiFileDiff
                        oldFile={{ name: commit.oldPath ?? commit.path, contents: contents.original }}
                        newFile={{ name: commit.path, contents: contents.modified }}
                        options={options}
                    />
                </div>
            )}
        </div>
    );
}
