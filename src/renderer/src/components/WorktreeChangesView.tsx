import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MultiFileDiff, Virtualizer } from '@pierre/diffs/react';
import { ChevronRight, FileText, GitCompareArrows, LoaderCircle, Minus, Plus, RefreshCw, Search, Undo2 } from 'lucide-react';
import { changeLetter, type ChangeContents, type ChangeSide, type FileChange } from '@shared/git';
import type { DiffSide } from '@shared/github';
import { changePatch } from '@shared/change-search';
import { searchPatches, type PatchMatch } from '@shared/pr-search';
import { gitChanged, onGitChanged, useGitChanges } from '../git/git-store';
import { errorText } from '../util';
import { confirmDiscard } from './ChangesPanel';
import { FindBar, findLineElement, readStyle, STYLE_KEY, THEME_CSS, useColorMode, type DiffStyle } from './PullRequestFilesStream';
import { radioGroupKeys } from './keyboard';
import { isFindShortcut, openLogFind } from './log-find';
import { pluralize } from '@shared/format';
import { EmptyState } from './EmptyState';
import { Button, ButtonGroup, Count, IconButton, SkeletonRows } from './ui';

interface Props {
    worktree: string;
    /** True when the pane of this tab has the focus. Only then ⌘F opens the search bar. */
    focused: boolean;
    onOpenFile(path: string): void;
}

/** A changed file in the stream. A conflicted file shows the diff of the index and the working file. */
interface Entry {
    key: string;
    group: 'conflict' | ChangeSide;
    change: FileChange;
}

/** The two versions of a file, and the `version` of the load that read them. */
interface Loaded {
    contents?: ChangeContents;
    error?: string;
    version: number;
}

/** Above this number of files, the files start collapsed. Each open file reads two versions with git. */
const MAX_OPEN_FILES = 40;
/** The time to wait after a file event before the diffs load again. An agent can write many files quickly. */
const RELOAD_DELAY_MS = 250;
/** The most file loads that run at the same time. */
const LOAD_CONCURRENCY = 6;

const GROUP_TITLES: Record<Entry['group'], string> = { conflict: 'Merge conflicts', staged: 'Staged', unstaged: 'Changes' };

const sideOf = (entry: Entry): ChangeSide => (entry.group === 'staged' ? 'staged' : 'unstaged');

/** The patch of each loaded version pair. A search runs again after each load, so the patches stay in this cache. */
const patchCache = new WeakMap<ChangeContents, string>();

function cachedPatch(contents: ChangeContents): string {
    let patch = patchCache.get(contents);
    if (patch === undefined) {
        patch = changePatch(contents.original, contents.modified);
        patchCache.set(contents, patch);
    }
    return patch;
}

interface FileBodyProps {
    change: FileChange;
    side: ChangeSide;
    loaded: Loaded | undefined;
    /** The line of the current search match in this file. */
    highlight: { side: DiffSide; line: number } | undefined;
    diffStyle: DiffStyle;
    mode: 'light' | 'dark';
}

/** The diff of one changed file. */
const FileBody = memo(function FileBody({ change, side, loaded, highlight, diffStyle, mode }: FileBodyProps) {
    const options = useMemo(
        () => ({
            diffStyle,
            themeType: mode,
            disableFileHeader: true,
            overflow: 'wrap' as const,
            lineDiffType: 'word' as const,
            unsafeCSS: THEME_CSS
        }),
        [diffStyle, mode]
    );

    // The parent makes a new highlight object on each render. The memo uses the fields, so it keeps the same value.
    const highlightLine = highlight?.line;
    const highlightSide = highlight?.side;
    const selectedLines = useMemo(
        () =>
            highlightLine !== undefined && highlightSide !== undefined
                ? { start: highlightLine, end: highlightLine, side: highlightSide === 'LEFT' ? ('deletions' as const) : ('additions' as const) }
                : null,
        [highlightLine, highlightSide]
    );

    const contents = loaded?.contents;
    if (loaded?.error && !contents) return <div className="stream-file-note">{loaded.error}</div>;
    if (!contents)
        return (
            <div className="stream-file-note">
                <LoaderCircle size={13} className="spin" /> Loading the diff…
            </div>
        );
    if (contents.binary) return <div className="stream-file-note">This is a binary file. ShipWarden does not show its diff.</div>;
    if (contents.original === contents.modified) {
        return <div className="stream-file-note">No {side} changes in this file now.</div>;
    }
    return (
        <MultiFileDiff
            oldFile={{ name: change.oldPath ?? change.path, contents: contents.original }}
            newFile={{ name: change.path, contents: contents.modified }}
            options={options}
            selectedLines={selectedLines}
        />
    );
});

/**
 * All local changes of a worktree in one tab: the merge conflicts, the staged changes and the unstaged changes.
 * Each file has its diff and can collapse. The diffs load again when a file or the index changes.
 * ⌘F opens a search bar. The search reads the diff lines of all files and opens the file of each match.
 */
export function WorktreeChangesView({ worktree, focused, onOpenFile }: Props) {
    const { changes, error, reload } = useGitChanges(worktree);
    const mode = useColorMode();
    const [diffStyle, setDiffStyle] = useState<DiffStyle>(readStyle);
    /** The open state of each file, by entry key. A file without a value uses the default. */
    const [open, setOpen] = useState<Record<string, boolean>>({});
    const [version, setVersion] = useState(0);
    const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
    /** The version that each running load reads, by entry key. */
    const loading = useRef(new Map<string, number>());
    const sections = useRef(new Map<string, HTMLElement>());
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<string>();

    const [findOpen, setFindOpen] = useState(false);
    const [findRequest, setFindRequest] = useState(0);
    const [query, setQuery] = useState('');
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [matchIndex, setMatchIndex] = useState(0);

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

    // ⌘F opens the search bar when this tab has the focus and no CI log owns ⌘F. The capture phase gets the key before the diff can stop it.
    useEffect(() => {
        if (!focused) return;
        const onKey = (event: KeyboardEvent) => {
            if (isFindShortcut(event) && !openLogFind(event)) {
                event.preventDefault();
                event.stopPropagation();
                setFindOpen(true);
                setFindRequest(Date.now());
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [focused]);

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

    // Load the two versions of each open file. While the search bar shows, load all files, so the search finds
    // text in the collapsed files too. A file loads again after each new `version`.
    useEffect(() => {
        const todo = entries.filter(
            entry => (findOpen || (open[entry.key] ?? openByDefault)) && loaded[entry.key]?.version !== version && loading.current.get(entry.key) !== version
        );
        if (!todo.length) return;
        for (const entry of todo) loading.current.set(entry.key, version);
        let next = 0;
        const work = async () => {
            while (next < todo.length) {
                const entry = todo[next++];
                let result: Loaded;
                try {
                    result = { contents: await window.shipwarden.git.contents(worktree, entry.change.path, sideOf(entry), entry.change.oldPath), version };
                } catch (err) {
                    result = { error: errorText(err), version };
                }
                if (loading.current.get(entry.key) === version) loading.current.delete(entry.key);
                // An error keeps the last good versions on the screen.
                setLoaded(map => ({ ...map, [entry.key]: { ...result, contents: result.contents ?? map[entry.key]?.contents } }));
            }
        };
        for (let index = 0; index < Math.min(LOAD_CONCURRENCY, todo.length); index += 1) void work();
    }, [entries, open, openByDefault, findOpen, version, loaded, worktree]);

    const matches = useMemo((): PatchMatch[] => {
        if (!findOpen || !query) return [];
        const files = entries.flatMap(entry => {
            const contents = loaded[entry.key]?.contents;
            return contents && !contents.binary ? [{ path: entry.key, patch: cachedPatch(contents) }] : [];
        });
        return searchPatches(files, query, caseSensitive);
    }, [findOpen, query, caseSensitive, entries, loaded]);
    const currentIndex = Math.min(matchIndex, matches.length - 1);
    const current: PatchMatch | undefined = matches[currentIndex];

    /** Opens the file of a match and scrolls its line into view. The line can render some frames later. */
    const reveal = (match: PatchMatch) => {
        setOpen(map => ({ ...map, [match.path]: true }));
        let tries = 0;
        const step = () => {
            const section = sections.current.get(match.path);
            const element = section && findLineElement(section, match.side, match.line);
            if (element) {
                element.scrollIntoView({ block: 'center' });
                return;
            }
            // The virtual list renders only the files near the view. Scroll to the file, then look for the line again.
            if (tries === 0) section?.scrollIntoView({ block: 'start' });
            if (++tries < 30) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    };

    // A new search text goes to the first match.
    // biome-ignore lint/correctness/useExhaustiveDependencies: Only a new search text goes to the first match. A new diff load must not move the view.
    useEffect(() => {
        setMatchIndex(0);
        if (matches[0]) reveal(matches[0]);
    }, [query, caseSensitive]);

    const moveMatch = (step: 1 | -1) => {
        if (!matches.length) return;
        const target = (currentIndex + step + matches.length) % matches.length;
        setMatchIndex(target);
        reveal(matches[target]);
    };

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
        return error ? <div className="panel-message">{error}</div> : <SkeletonRows label="Loading the changes" />;
    }

    const fileCount = new Set(entries.map(entry => entry.change.path)).size;

    return (
        <div className="editor worktree-changes">
            {findOpen && (
                <FindBar
                    query={query}
                    caseSensitive={caseSensitive}
                    count={matches.length}
                    index={currentIndex}
                    focusNonce={findRequest}
                    onQuery={setQuery}
                    onCaseSensitive={setCaseSensitive}
                    onMove={moveMatch}
                    onClose={() => setFindOpen(false)}
                />
            )}
            <div className="files-stream-toolbar">
                <span className="files-stream-count">{fileCount === 0 ? 'No changes' : pluralize(fileCount, 'changed file')}</span>
                <span className="header-spacer" />
                {entries.length > 0 && (
                    <>
                        <Button variant="link" onClick={() => setOpen(Object.fromEntries(entries.map(entry => [entry.key, false])))}>
                            Collapse all
                        </Button>
                        <Button variant="link" onClick={() => setOpen(Object.fromEntries(entries.map(entry => [entry.key, true])))}>
                            Expand all
                        </Button>
                    </>
                )}
                <ButtonGroup size="sm" role="radiogroup" label="Diff layout" onKeyDown={radioGroupKeys}>
                    <Button size="sm" role="radio" aria-checked={diffStyle === 'unified'} onClick={() => changeStyle('unified')}>
                        Unified
                    </Button>
                    <Button size="sm" role="radio" aria-checked={diffStyle === 'split'} onClick={() => changeStyle('split')}>
                        Split
                    </Button>
                </ButtonGroup>
                <IconButton
                    size="sm"
                    icon={<Search size={14} strokeWidth={1.6} />}
                    label="Find in the changes (⌘F)"
                    onClick={() => {
                        setFindOpen(true);
                        setFindRequest(Date.now());
                    }}
                />
                <IconButton size="sm" icon={<RefreshCw size={14} strokeWidth={1.6} />} label="Load again" onClick={reloadAll} />
            </div>
            {(actionError || error) && <div className="editor-failure">{actionError ?? error}</div>}
            {entries.length === 0 ? (
                <EmptyState icon={GitCompareArrows} title="No changes">
                    The working tree is clean.
                </EmptyState>
            ) : (
                <Virtualizer className="files-stream-scroll" contentClassName="files-stream-content">
                    {entries.map((entry, index) => {
                        const { change, group } = entry;
                        const expanded = isOpen(entry);
                        const firstOfGroup = index === 0 || entries[index - 1].group !== group;
                        const count = firstOfGroup ? entries.filter(item => item.group === group).length : 0;
                        return (
                            <div key={entry.key}>
                                {firstOfGroup && (
                                    <h3 className="worktree-changes-group">
                                        {GROUP_TITLES[group]} <Count value={count} label={pluralize(count, 'file')} />
                                    </h3>
                                )}
                                <section
                                    className={`stream-file${expanded ? ' open' : ''}`}
                                    ref={element => {
                                        if (element) sections.current.set(entry.key, element);
                                        else sections.current.delete(entry.key);
                                    }}
                                >
                                    <header className="stream-file-header" onClick={() => setOpen(map => ({ ...map, [entry.key]: !expanded }))}>
                                        <button className="row-toggle" aria-expanded={expanded}>
                                            <ChevronRight size={14} strokeWidth={1.8} className={`group-chevron${expanded ? ' open' : ''}`} />
                                            <span className={`change-letter ${change.kind}`}>{changeLetter(change.kind)}</span>
                                            <span className="stream-file-path" title={change.path}>
                                                {change.oldPath ? `${change.oldPath} → ` : ''}
                                                {change.path}
                                            </span>
                                        </button>
                                        <span className="change-actions worktree-changes-actions" onClick={event => event.stopPropagation()}>
                                            {change.kind !== 'deleted' && (
                                                <IconButton
                                                    size="sm"
                                                    icon={<FileText size={13} strokeWidth={1.7} />}
                                                    label="Open the file"
                                                    onClick={() => onOpenFile(change.path)}
                                                />
                                            )}
                                            {group === 'unstaged' && (
                                                <IconButton
                                                    size="sm"
                                                    icon={<Undo2 size={13} strokeWidth={1.8} />}
                                                    label="Discard the changes"
                                                    disabled={busy}
                                                    onClick={() => void act(() => confirmDiscard(worktree, [change]))}
                                                />
                                            )}
                                            {group === 'staged' ? (
                                                <IconButton
                                                    size="sm"
                                                    icon={<Minus size={14} strokeWidth={2} />}
                                                    label="Unstage"
                                                    disabled={busy}
                                                    onClick={() => void act(() => window.shipwarden.git.unstage(worktree, [change.path]))}
                                                />
                                            ) : (
                                                <IconButton
                                                    size="sm"
                                                    icon={<Plus size={14} strokeWidth={2} />}
                                                    label={group === 'conflict' ? 'Mark as resolved (stage)' : 'Stage'}
                                                    disabled={busy}
                                                    onClick={() => void act(() => window.shipwarden.git.stage(worktree, [change.path]))}
                                                />
                                            )}
                                        </span>
                                    </header>
                                    {expanded && (
                                        <FileBody
                                            change={change}
                                            side={sideOf(entry)}
                                            loaded={loaded[entry.key]}
                                            highlight={findOpen && current?.path === entry.key ? current : undefined}
                                            diffStyle={diffStyle}
                                            mode={mode}
                                        />
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
