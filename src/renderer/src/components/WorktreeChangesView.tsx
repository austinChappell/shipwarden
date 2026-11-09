import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { MultiFileDiff, Virtualizer } from '@pierre/diffs/react';
import { ChevronRight, FileText, LoaderCircle, Minus, Plus, RefreshCw, Undo2 } from 'lucide-react';
import { changeLetter, type ChangeContents, type ChangeSide, type FileChange } from '@shared/git';
import { gitChanged, onGitChanged, useGitChanges } from '../git/git-store';
import { errorText } from '../util';
import { confirmDiscard } from './ChangesPanel';
import { readStyle, STYLE_KEY, THEME_CSS, useColorMode, type DiffStyle } from './PullRequestFilesStream';

interface Props {
    worktree: string;
    onOpenFile(path: string): void;
}

/** A changed file in the stream. A conflicted file shows the diff of the index and the working file. */
interface Entry {
    key: string;
    group: 'conflict' | ChangeSide;
    change: FileChange;
}

/** Above this number of files, the files start collapsed. Each open file reads two versions with git. */
const MAX_OPEN_FILES = 40;
/** The time to wait after a file event before the open diffs load again. An agent can write many files quickly. */
const RELOAD_DELAY_MS = 250;

const GROUP_TITLES: Record<Entry['group'], string> = { conflict: 'Merge conflicts', staged: 'Staged', unstaged: 'Changes' };

interface FileBodyProps {
    worktree: string;
    change: FileChange;
    side: ChangeSide;
    /** A new value loads the two versions again. */
    version: number;
    diffStyle: DiffStyle;
    mode: 'light' | 'dark';
}

/** The diff of one changed file. It loads the two versions of the file again when `version` changes. */
const FileBody = memo(function FileBody({ worktree, change, side, version, diffStyle, mode }: FileBodyProps) {
    const [contents, setContents] = useState<ChangeContents>();
    const [error, setError] = useState<string>();

    useEffect(() => {
        let current = true;
        window.shipwarden.git.contents(worktree, change.path, side, change.oldPath).then(
            result => {
                if (!current) return;
                setContents(result);
                setError(undefined);
            },
            err => current && setError(errorText(err))
        );
        return () => {
            current = false;
        };
    }, [worktree, change.path, change.oldPath, side, version]);

    const options = useMemo(() => ({
        diffStyle,
        themeType: mode,
        disableFileHeader: true,
        overflow: 'wrap' as const,
        lineDiffType: 'word' as const,
        unsafeCSS: THEME_CSS
    }), [diffStyle, mode]);

    if (error) return <div className="stream-file-note">{error}</div>;
    if (!contents) return <div className="stream-file-note"><LoaderCircle size={13} className="spin" /> Loading the diff…</div>;
    if (contents.binary) return <div className="stream-file-note">This is a binary file. ShipWarden does not show its diff.</div>;
    if (contents.original === contents.modified) {
        return <div className="stream-file-note">No {side} changes in this file now.</div>;
    }
    return (
        <MultiFileDiff
            oldFile={{ name: change.oldPath ?? change.path, contents: contents.original }}
            newFile={{ name: change.path, contents: contents.modified }}
            options={options}
        />
    );
});

/**
 * All local changes of a worktree in one tab: the merge conflicts, the staged changes and the unstaged changes.
 * Each file has its diff and can collapse. The open diffs load again when a file or the index changes.
 */
export function WorktreeChangesView({ worktree, onOpenFile }: Props) {
    const { changes, error, reload } = useGitChanges(worktree);
    const mode = useColorMode();
    const [diffStyle, setDiffStyle] = useState<DiffStyle>(readStyle);
    /** The open state of each file, by entry key. A file without a value uses the default. */
    const [open, setOpen] = useState<Record<string, boolean>>({});
    const [version, setVersion] = useState(0);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<string>();

    const reloadAll = useCallback(() => {
        setVersion(value => value + 1);
        reload();
    }, [reload]);

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const later = () => {
            clearTimeout(timer);
            timer = setTimeout(() => setVersion(value => value + 1), RELOAD_DELAY_MS);
        };
        const offFiles = window.shipwarden.files.onChanged(event => event.root === worktree && later());
        const offGit = onGitChanged(later);
        window.addEventListener('focus', later);
        return () => {
            clearTimeout(timer);
            offFiles();
            offGit();
            window.removeEventListener('focus', later);
        };
    }, [worktree]);

    const entries = useMemo((): Entry[] => {
        if (!changes) return [];
        return [
            ...changes.conflicted.map(change => ({ key: `conflict:${change.path}`, group: 'conflict' as const, change })),
            ...changes.staged.map(change => ({ key: `staged:${change.path}`, group: 'staged' as const, change })),
            ...changes.unstaged.map(change => ({ key: `unstaged:${change.path}`, group: 'unstaged' as const, change }))
        ];
    }, [changes]);

    const openByDefault = entries.length <= MAX_OPEN_FILES;
    const isOpen = (entry: Entry) => open[entry.key] ?? openByDefault;

    const changeStyle = (value: DiffStyle) => {
        setDiffStyle(value);
        try {
            localStorage.setItem(STYLE_KEY, value);
        } catch {
            // The choice stays for this session only.
        }
    };

    /** Runs a git action, then tells the views to read the changes again. */
    const act = async (action: () => Promise<unknown>) => {
        setBusy(true);
        setActionError(undefined);
        try {
            await action();
        } catch (err) {
            setActionError(errorText(err));
        } finally {
            setBusy(false);
            gitChanged();
        }
    };

    if (!changes) {
        return <div className="panel-message">{error ?? <><LoaderCircle size={14} className="spin" /> Reading the changes…</>}</div>;
    }

    const fileCount = new Set(entries.map(entry => entry.change.path)).size;

    return (
        <div className="editor worktree-changes">
            <div className="files-stream-toolbar">
                <span className="files-stream-count">
                    {fileCount === 0 ? 'No changes' : `${fileCount} changed ${fileCount === 1 ? 'file' : 'files'}`}
                </span>
                <span className="header-spacer" />
                {entries.length > 0 && (
                    <>
                        <button className="link-button" onClick={() => setOpen(Object.fromEntries(entries.map(entry => [entry.key, false])))}>Collapse all</button>
                        <button className="link-button" onClick={() => setOpen(Object.fromEntries(entries.map(entry => [entry.key, true])))}>Expand all</button>
                    </>
                )}
                <div className="segmented compact" role="radiogroup" aria-label="Diff layout">
                    <button className={diffStyle === 'unified' ? 'selected' : ''} onClick={() => changeStyle('unified')}>Unified</button>
                    <button className={diffStyle === 'split' ? 'selected' : ''} onClick={() => changeStyle('split')}>Split</button>
                </div>
                <button className="icon-button" title="Load again" onClick={reloadAll}><RefreshCw size={14} strokeWidth={1.6} /></button>
            </div>
            {(actionError || error) && <div className="editor-failure">{actionError ?? error}</div>}
            {entries.length === 0 ? (
                <div className="panel-message">No changes. The working tree is clean.</div>
            ) : (
                <Virtualizer className="files-stream-scroll" contentClassName="files-stream-content">
                    {entries.map((entry, index) => {
                        const { change, group } = entry;
                        const side: ChangeSide = group === 'staged' ? 'staged' : 'unstaged';
                        const expanded = isOpen(entry);
                        const firstOfGroup = index === 0 || entries[index - 1].group !== group;
                        const count = firstOfGroup ? entries.filter(item => item.group === group).length : 0;
                        return (
                            <div key={entry.key}>
                                {firstOfGroup && (
                                    <h3 className="worktree-changes-group">
                                        {GROUP_TITLES[group]} <span className="changes-group-count">{count}</span>
                                    </h3>
                                )}
                                <section className={`stream-file${expanded ? ' open' : ''}`}>
                                    <header className="stream-file-header" onClick={() => setOpen(map => ({ ...map, [entry.key]: !expanded }))}>
                                        <ChevronRight size={14} strokeWidth={1.8} className={`group-chevron${expanded ? ' open' : ''}`} />
                                        <span className={`change-letter ${change.kind}`}>{changeLetter(change.kind)}</span>
                                        <span className="stream-file-path" title={change.path}>
                                            {change.oldPath ? `${change.oldPath} → ` : ''}{change.path}
                                        </span>
                                        <span className="change-actions worktree-changes-actions" onClick={event => event.stopPropagation()}>
                                            {change.kind !== 'deleted' && (
                                                <button className="icon-button" title="Open the file" onClick={() => onOpenFile(change.path)}>
                                                    <FileText size={13} strokeWidth={1.7} />
                                                </button>
                                            )}
                                            {group === 'unstaged' && (
                                                <button className="icon-button" title="Discard the changes" disabled={busy} onClick={() => void act(() => confirmDiscard(worktree, [change]))}>
                                                    <Undo2 size={13} strokeWidth={1.8} />
                                                </button>
                                            )}
                                            {group === 'staged' ? (
                                                <button className="icon-button" title="Unstage" disabled={busy} onClick={() => void act(() => window.shipwarden.git.unstage(worktree, [change.path]))}>
                                                    <Minus size={14} strokeWidth={2} />
                                                </button>
                                            ) : (
                                                <button
                                                    className="icon-button"
                                                    title={group === 'conflict' ? 'Mark as resolved (stage)' : 'Stage'}
                                                    disabled={busy}
                                                    onClick={() => void act(() => window.shipwarden.git.stage(worktree, [change.path]))}
                                                >
                                                    <Plus size={14} strokeWidth={2} />
                                                </button>
                                            )}
                                        </span>
                                    </header>
                                    {expanded && (
                                        <FileBody worktree={worktree} change={change} side={side} version={version} diffStyle={diffStyle} mode={mode} />
                                    )}
                                </section>
                            </div>
                        );
                    })}
                </Virtualizer>
            )}
        </div>
    );
}
