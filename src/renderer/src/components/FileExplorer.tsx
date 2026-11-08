import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Ban, ChevronRight, File, ListCollapse, RefreshCw, Search, TextAlignStart } from 'lucide-react';
import { baseName, matchLine, parentPath, type ContentMatch, type FileEntry } from '@shared/files';
import { fileIcon, folderIcon } from '../files/file-icons';
import { fuzzyFilter } from '../files/fuzzy';

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
    const bodyRef = useRef<HTMLDivElement>(null);
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

    const toggle = (entry: FileEntry) => {
        setExpanded(set => {
            const next = new Set(set);
            if (next.has(entry.path)) {
                next.delete(entry.path);
            } else {
                next.add(entry.path);
                if (!childrenRef.current.has(entry.path)) {
                    loadDirectory(entry.path);
                }
            }
            return next;
        });
    };

    const nameMatches = useMemo(
        () => (mode === 'names' && query && allFiles ? fuzzyFilter(allFiles, query) : []),
        [mode, query, allFiles]
    );

    const renderTree = (directory: string, depth: number): ReactNode[] => {
        const entries = children.get(directory);
        if (!entries) {
            return [];
        }
        const rows: ReactNode[] = [];
        for (const entry of entries) {
            const open = expanded.has(entry.path);
            const Icon = entry.isDirectory ? folderIcon(open) : fileIcon(entry.name);
            rows.push(
                <div
                    key={entry.path}
                    className={`tree-row${entry.ignored ? ' ignored' : ''}${entry.path === activePath ? ' active' : ''}`}
                    style={{ paddingLeft: 8 + depth * INDENT }}
                    title={entry.path}
                    onClick={() => (entry.isDirectory ? toggle(entry) : onOpenFile(entry.path))}
                >
                    <span className={`tree-chevron${open ? ' open' : ''}`}>
                        {entry.isDirectory && <ChevronRight size={14} strokeWidth={ICON_STROKE} />}
                    </span>
                    <Icon className="tree-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                    <span className="tree-name">{entry.name}</span>
                    {entry.ignored && <Ban className="tree-ignored" size={14} strokeWidth={ICON_STROKE} aria-label="Ignored by git" />}
                </div>
            );
            if (entry.isDirectory && open) {
                rows.push(...renderTree(entry.path, depth + 1));
            }
        }
        return rows;
    };

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
                {!query && renderTree('', 0)}
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
