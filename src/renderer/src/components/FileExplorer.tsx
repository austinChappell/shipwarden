import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Ban, ChevronRight, File, ListCollapse, RefreshCw, Search, TextAlignStart } from 'lucide-react';
import { baseName, matchLine, parentPath, type ContentMatch, type FileEntry } from '@shared/files';
import { fileIcon, folderIcon } from '../files/file-icons';
import { fuzzyFilter } from '../files/fuzzy';
import { onExplorerFocusRequest, takeExplorerFocusRequest } from '../files/explorer-focus';
import { treeKeyAction, type TreeRow } from '../files/tree-nav';

type Mode = 'names' | 'contents';

interface Props {
    root: string;
    /** The relative path of the file in the active editor tab. The explorer highlights it. */
    activePath?: string;
    onOpenFile(path: string, line?: number): void;
}

const api = window.shipwarden.files;
const ICON_SIZE = 16;
const ICON_STROKE = 1.5;
const INDENT = 14;

function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** Splits text around each case-insensitive match of the query, so that the matches can show in bold. */
function highlight(text: string, query: string): ReactNode {
    if (!query) {
        return text;
    }
    const lower = text.toLowerCase();
    const needle = query.toLowerCase();
    const parts: ReactNode[] = [];
    let start = 0;
    let index = lower.indexOf(needle);
    while (index !== -1) {
        parts.push(text.slice(start, index), <mark key={index}>{text.slice(index, index + needle.length)}</mark>);
        start = index + needle.length;
        index = lower.indexOf(needle, start);
    }
    parts.push(text.slice(start));
    return parts;
}

/** The file explorer: a tree of the worktree, a file name filter and a content search. */
export function FileExplorer({ root, activePath, onOpenFile }: Props) {
    const [mode, setMode] = useState<Mode>('names');
    const [query, setQuery] = useState('');
    const [children, setChildren] = useState<Map<string, FileEntry[]>>(new Map());
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [allFiles, setAllFiles] = useState<string[]>();
    const [contentResults, setContentResults] = useState<{ query: string; matches: ContentMatch[]; truncated: boolean }>();
    const [searching, setSearching] = useState(false);
    const [error, setError] = useState<string>();
    /** The result that Enter opens. The arrow keys move it. */
    const [active, setActive] = useState(0);
    /** The tree row that the arrow keys move. It shows only while the tree has the keyboard focus. */
    const [cursor, setCursor] = useState<string>();
    const bodyRef = useRef<HTMLDivElement>(null);
    const treeRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    /** The cursor row that the tree scrolled to last. */
    const scrolledTo = useRef<string | undefined>(undefined);
    const childrenRef = useRef(children);
    childrenRef.current = children;

    const loadDirectory = useCallback(async (directory: string) => {
        try {
            const entries = await api.listDirectory(root, directory);
            setChildren(map => new Map(map).set(directory, entries));
        } catch (err) {
            // A folder that was deleted cannot load. Remove it from the cache.
            setChildren(map => {
                const next = new Map(map);
                next.delete(directory);
                return next;
            });
            if (directory === '') {
                setError(errorText(err));
            }
        }
    }, [root]);

    const reloadLoaded = useCallback((directories?: string[]) => {
        const loaded = [...childrenRef.current.keys()];
        for (const directory of directories ? loaded.filter(dir => directories.includes(dir)) : loaded) {
            loadDirectory(directory);
        }
    }, [loadDirectory]);

    // Load the root and watch the worktree for changes.
    useEffect(() => {
        setChildren(new Map());
        setExpanded(new Set());
        setAllFiles(undefined);
        setError(undefined);
        loadDirectory('');
        api.watch(root);
        const unsubscribe = api.onChanged(event => {
            if (event.root === root) {
                reloadLoaded(event.directories);
                setAllFiles(undefined);
            }
        });
        return () => {
            unsubscribe();
            api.unwatch(root);
        };
    }, [root, loadDirectory, reloadLoaded]);

    // The name filter needs the full file list. Load it when the user types.
    useEffect(() => {
        if (mode === 'names' && query && !allFiles) {
            api.listFiles(root).then(setAllFiles, err => setError(errorText(err)));
        }
    }, [mode, query, allFiles, root]);

    // Search the contents after a short pause in typing.
    useEffect(() => {
        if (mode !== 'contents' || !query.trim()) {
            setContentResults(undefined);
            return;
        }
        let cancelled = false;
        setSearching(true);
        const timer = setTimeout(() => {
            api.searchContents(root, query).then(
                result => !cancelled && setContentResults({ query, ...result }),
                err => !cancelled && setError(errorText(err))
            ).finally(() => !cancelled && setSearching(false));
        }, 250);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [mode, query, root]);

    /** Expands or collapses a folder. Without `open`, the folder changes to the other state. */
    const setFolderOpen = (path: string, open?: boolean) => {
        setExpanded(set => {
            const expand = open ?? !set.has(path);
            if (expand === set.has(path)) {
                return set;
            }
            const next = new Set(set);
            if (expand) {
                next.add(path);
                if (!childrenRef.current.has(path)) {
                    loadDirectory(path);
                }
            } else {
                next.delete(path);
            }
            return next;
        });
    };

    const nameMatches = useMemo(
        () => (mode === 'names' && query && allFiles ? fuzzyFilter(allFiles, query) : []),
        [mode, query, allFiles]
    );

    /** The visible tree rows, in the order of the tree. The rows of a collapsed folder are not in the list. */
    const treeRows = useMemo(() => {
        const rows: (TreeRow & { entry: FileEntry; depth: number })[] = [];
        const add = (directory: string, depth: number) => {
            for (const entry of children.get(directory) ?? []) {
                const open = entry.isDirectory && expanded.has(entry.path);
                rows.push({ entry, depth, path: entry.path, isDirectory: entry.isDirectory, open, parent: directory });
                if (open) {
                    add(entry.path, depth + 1);
                }
            }
        };
        add('', 0);
        return rows;
    }, [children, expanded]);

    // Scroll to the cursor row when the cursor moves. The row can show later, after its folder loads.
    useEffect(() => {
        if (cursor === scrolledTo.current) {
            return;
        }
        const row = treeRef.current?.querySelector('.tree-row.cursor');
        if (row) {
            row.scrollIntoView({ block: 'nearest' });
            scrolledTo.current = cursor;
        }
    }, [cursor, treeRows]);

    /**
     * Moves the keyboard focus to the explorer (⇧⌘E). With a query, the search box gets the focus.
     * Else the tree gets the focus, and the cursor goes to the active file. The parent folders of that file expand.
     */
    const takeFocus = () => {
        if (query) {
            inputRef.current?.focus();
            return;
        }
        // The focus event can put the cursor on the first row. The cursor of the active file comes after it.
        treeRef.current?.focus();
        if (activePath) {
            const parts = activePath.split('/');
            for (let index = 1; index < parts.length; index += 1) {
                setFolderOpen(parts.slice(0, index).join('/'), true);
            }
            setCursor(activePath);
        }
        scrolledTo.current = undefined;
    };
    const takeFocusRef = useRef(takeFocus);
    takeFocusRef.current = takeFocus;
    useEffect(() => {
        const run = () => {
            if (takeExplorerFocusRequest()) {
                takeFocusRef.current();
            }
        };
        // A request can come before the explorer mounts, for example when ⇧⌘E shows the right panel.
        run();
        return onExplorerFocusRequest(run);
    }, []);

    const onTreeFocus = (event: React.FocusEvent<HTMLDivElement>) => {
        // A click on a row sets the cursor itself. A focus from the keyboard starts at the active file or the first row.
        if (event.target !== event.currentTarget || treeRows.some(row => row.path === cursor)) {
            return;
        }
        setCursor(treeRows.find(row => row.path === activePath)?.path ?? treeRows[0]?.path);
    };

    const onTreeKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.metaKey || event.ctrlKey || event.altKey) {
            return;
        }
        const action = treeKeyAction(treeRows, cursor, event.key);
        if (!action) {
            return;
        }
        event.preventDefault();
        switch (action.kind) {
            case 'move':
                setCursor(action.path);
                break;
            case 'expand':
                setFolderOpen(action.path, true);
                break;
            case 'collapse':
                setFolderOpen(action.path, false);
                break;
            case 'toggle':
                setFolderOpen(action.path);
                break;
            case 'open':
                // The editor of the file takes the keyboard focus.
                onOpenFile(action.path);
                break;
        }
    };

    const renderTree = () => (
        <div
            ref={treeRef}
            className="explorer-tree"
            role="tree"
            aria-label="Files"
            tabIndex={0}
            onFocus={onTreeFocus}
            onKeyDown={onTreeKey}
        >
            {treeRows.map(({ entry, depth, open }) => {
                const Icon = entry.isDirectory ? folderIcon(open) : fileIcon(entry.name);
                return (
                    <div
                        key={entry.path}
                        role="treeitem"
                        aria-expanded={entry.isDirectory ? open : undefined}
                        aria-selected={entry.path === cursor}
                        className={`tree-row${entry.ignored ? ' ignored' : ''}${entry.path === activePath ? ' active' : ''}${entry.path === cursor ? ' cursor' : ''}`}
                        style={{ paddingLeft: 8 + depth * INDENT }}
                        title={entry.path}
                        onClick={() => {
                            setCursor(entry.path);
                            if (entry.isDirectory) {
                                setFolderOpen(entry.path);
                            } else {
                                onOpenFile(entry.path);
                            }
                        }}
                    >
                        <span className={`tree-chevron${open ? ' open' : ''}`}>
                            {entry.isDirectory && <ChevronRight size={14} strokeWidth={ICON_STROKE} />}
                        </span>
                        <Icon className="tree-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                        <span className="tree-name">{entry.name}</span>
                        {entry.ignored && <Ban className="tree-ignored" size={14} strokeWidth={ICON_STROKE} aria-label="Ignored by git" />}
                    </div>
                );
            })}
        </div>
    );

    /** The results in the order of the list: a file, or a line of a file. Enter opens the active one. */
    const contentGroups = useMemo(() => {
        const groups = new Map<string, ContentMatch[]>();
        for (const match of contentResults?.matches ?? []) {
            groups.set(match.path, [...(groups.get(match.path) ?? []), match]);
        }
        return [...groups.entries()];
    }, [contentResults]);
    const results: { path: string; line?: number }[] = useMemo(() => (mode === 'names'
        ? nameMatches.map(({ path }) => ({ path }))
        : contentGroups.flatMap(([path, matches]) => matches.map(match => ({ path, line: match.line })))), [mode, nameMatches, contentGroups]);

    useEffect(() => setActive(0), [results]);
    useEffect(() => {
        bodyRef.current?.querySelector('.search-result.selected')?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    const flipMode = () => setMode(current => (current === 'names' ? 'contents' : 'names'));
    const onSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Tab' && event.altKey) {
            // ⌥Tab changes between names and contents. The query stays.
            event.preventDefault();
            flipMode();
        } else if (event.key === 'Escape') {
            setQuery('');
        } else if (event.key === 'ArrowDown' && !query) {
            // With no query, Down moves the focus from the search box to the tree.
            event.preventDefault();
            treeRef.current?.focus();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(index => Math.max(0, Math.min(results.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))));
        } else if (event.key === 'Enter') {
            const result = results[active];
            if (result) onOpenFile(result.path, result.line);
        }
    };

    const summary = (count: number, more = false) => (
        <div className="search-summary">{mode === 'names' ? 'Files' : 'Contents'} · {count}{more ? '+' : ''} {count === 1 ? 'match' : 'matches'}</div>
    );

    const renderNameMatches = () => {
        if (!allFiles) {
            return <div className="explorer-message">Loading files…</div>;
        }
        if (nameMatches.length === 0) {
            return <div className="explorer-message">No files match "{query}".</div>;
        }
        return (
            <>
                {summary(nameMatches.length)}
                {nameMatches.map(({ path }, index) => {
                    const Icon = fileIcon(baseName(path));
                    return (
                        <div
                            key={path}
                            className={`search-result search-name${index === active ? ' selected' : ''}`}
                            title={path}
                            onMouseMove={() => index !== active && setActive(index)}
                            onClick={() => onOpenFile(path)}
                        >
                            <Icon className="tree-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                            <span className="search-file-name">{baseName(path)}</span>
                            <span className="search-file-path">{parentPath(path)}</span>
                        </div>
                    );
                })}
            </>
        );
    };

    const renderContentMatches = () => {
        if (!contentResults) {
            return <div className="explorer-message">{searching ? 'Searching…' : 'Type to search the file contents.'}</div>;
        }
        if (contentResults.matches.length === 0) {
            return <div className="explorer-message">No results for "{contentResults.query}".</div>;
        }
        let index = -1;
        return (
            <>
                {summary(contentResults.matches.length, contentResults.truncated)}
                {contentGroups.map(([path, matches]) => (
                    <div key={path} className="search-group">
                        <div className="search-group-head" title={path} onClick={() => onOpenFile(path, matches[0].line)}>
                            <span className="search-file-name">{baseName(path)}</span>
                            <span className="search-file-path">{parentPath(path)}</span>
                            <span className="search-count">{matches.length}</span>
                        </div>
                        {matches.map(match => {
                            index += 1;
                            const position = index;
                            return (
                                <div
                                    key={`${path}:${match.line}`}
                                    className={`search-result search-line${position === active ? ' selected' : ''}`}
                                    onMouseMove={() => position !== active && setActive(position)}
                                    onClick={() => onOpenFile(path, match.line)}
                                >
                                    <span className="search-line-number">{match.line}</span>
                                    <span className="search-text" title={match.text.trim()}>{highlight(matchLine(match.text, contentResults.query), contentResults.query)}</span>
                                </div>
                            );
                        })}
                    </div>
                ))}
                {contentResults.truncated && <div className="explorer-message">Only the first {contentResults.matches.length} results show.</div>}
            </>
        );
    };

    return (
        <div className="panel-body">
            <div className="explorer-header">
                <span className="explorer-title" title={root}>{baseName(root)}</span>
                <button className="icon-button" title="Collapse all folders" onClick={() => setExpanded(new Set())}>
                    <ListCollapse size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                </button>
                <button className="icon-button" title="Refresh" onClick={() => { reloadLoaded(); setAllFiles(undefined); }}>
                    <RefreshCw size={ICON_SIZE - 1} strokeWidth={ICON_STROKE} />
                </button>
            </div>

            <div className="explorer-controls">
                <label className="explorer-search">
                    <Search size={ICON_SIZE - 1} strokeWidth={ICON_STROKE} />
                    <input
                        ref={inputRef}
                        value={query}
                        placeholder={mode === 'names' ? 'Find files by name' : 'Search in files'}
                        spellCheck={false}
                        onChange={event => setQuery(event.target.value)}
                        onKeyDown={onSearchKey}
                    />
                    <span className="search-mode" role="radiogroup" aria-label="Search">
                        <button
                            type="button"
                            role="radio"
                            aria-checked={mode === 'names'}
                            className={mode === 'names' ? 'selected' : ''}
                            title="File names (⌥Tab)"
                            onClick={() => setMode('names')}
                        >
                            <File size={14} strokeWidth={1.6} />
                        </button>
                        <button
                            type="button"
                            role="radio"
                            aria-checked={mode === 'contents'}
                            className={mode === 'contents' ? 'selected' : ''}
                            title="File contents (⌥Tab)"
                            onClick={() => setMode('contents')}
                        >
                            <TextAlignStart size={14} strokeWidth={1.6} />
                        </button>
                    </span>
                </label>
            </div>

            <div className="explorer-body" ref={bodyRef}>
                {error && <div className="explorer-message error" onClick={() => setError(undefined)}>{error}</div>}
                {!query && renderTree()}
                {query && mode === 'names' && renderNameMatches()}
                {mode === 'contents' && query && renderContentMatches()}
            </div>
            {query && (
                <div className="search-footer">
                    <kbd>⌥Tab</kbd> flips names ⇄ contents <span className="search-footer-note">The query stays.</span>
                </div>
            )}
        </div>
    );
}
