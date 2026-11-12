import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Ban, CaseSensitive, ChevronRight, File, FilePlus, FolderPlus, ListCollapse, RefreshCw, Search, TextAlignStart } from 'lucide-react';
import { baseName, fileNameError, isSameOrInside, joinPath, matchLine, parentPath, type ContentMatch, type FileEntry } from '@shared/files';
import { fileIcon, folderIcon } from '../files/file-icons';
import { fuzzyFilter, fuzzyPositions } from '../files/fuzzy';
import { onExplorerFocusRequest, takeExplorerFocusRequest } from '../files/explorer-focus';
import { treeKeyAction, type TreeRow } from '../files/tree-nav';
import { ErrorBanner } from './ErrorBanner';
import { confirmDialog } from './ConfirmDialog';
import { showContextMenu, type ContextMenuItem } from './ContextMenu';
import { pluralize } from '@shared/format';
import { Count, IconButton, Input, inputClass, SkeletonRows } from './ui';

type Mode = 'names' | 'contents';

/** The row with a text field: a rename of `path`, or a new file or folder in the folder `parent`. */
type Edit = { kind: 'rename'; path: string } | { kind: 'file' | 'folder'; parent: string };

interface Props {
    root: string;
    /** The relative path of the file in the active editor tab. The explorer highlights it. */
    activePath?: string;
    onOpenFile(path: string, line?: number): void;
    /** The name in the header. The default is the folder name of the root. */
    title?: string;
    /** The explorer renamed or moved a file or a folder. */
    onMoved?(from: string, to: string): void;
    /** The explorer moved files or folders to the Trash. */
    onDeleted?(paths: string[]): void;
}

const api = window.shipwarden.files;
const ICON_SIZE = 16;
const ICON_STROKE = 1.5;
const INDENT = 14;
const CASE_SENSITIVE_KEY = 'shipwarden.explorerCaseSensitive';
/** The time that the pointer stays on a closed folder in a drag before the folder opens. */
const DRAG_EXPAND_MS = 700;

/** Reads the saved case setting. The default is a search that ignores case. */
function readCaseSensitive(): boolean {
    try {
        return localStorage.getItem(CASE_SENSITIVE_KEY) === 'true';
    } catch {
        return false;
    }
}

function saveCaseSensitive(value: boolean): void {
    try {
        localStorage.setItem(CASE_SENSITIVE_KEY, String(value));
    } catch {
        // The setting stays only for this session.
    }
}

function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** Splits text around each match of the query, so that the matches can show in bold. The match ignores case when `caseSensitive` is false. */
function highlight(text: string, query: string, caseSensitive: boolean): ReactNode {
    if (!query) {
        return text;
    }
    const lower = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
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

/**
 * Marks the characters of `text` at the given positions. `offset` is the index of the first character of `text` in the full path.
 * Adjacent positions go into one mark.
 */
function markPositions(text: string, positions: readonly number[], offset: number): ReactNode {
    const marked = new Set(positions.map(position => position - offset).filter(index => index >= 0 && index < text.length));
    if (marked.size === 0) {
        return text;
    }
    const parts: ReactNode[] = [];
    let start = 0;
    while (start < text.length) {
        const isMark = marked.has(start);
        let end = start + 1;
        while (end < text.length && marked.has(end) === isMark) {
            end += 1;
        }
        const piece = text.slice(start, end);
        parts.push(isMark ? <mark key={start}>{piece}</mark> : piece);
        start = end;
    }
    return parts;
}

/** Returns the tree row of a DOM element, or null when the element is not in a row. */
function rowOf(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>('[data-path]') : null;
}

interface EditRowProps {
    depth: number;
    isDirectory: boolean;
    /** The name at the start. A rename selects the name without the extension. */
    initial: string;
    label: string;
    /** Makes the change. `fromBlur` is true when the field lost the focus. Returns the error text when the change fails. */
    onCommit(name: string, fromBlur: boolean): Promise<string | undefined>;
    onCancel(): void;
    /** The change failed after the field lost the focus. The field closes and the explorer shows the error. */
    onFail(message: string): void;
}

/** A tree row with a text field, for a new name. Enter saves the name and Escape cancels. A click outside saves the name. */
function EditRow({ depth, isDirectory, initial, label, onCommit, onCancel, onFail }: EditRowProps) {
    const [value, setValue] = useState(initial);
    const [error, setError] = useState<string>();
    const inputRef = useRef<HTMLInputElement>(null);
    /** True while the change runs. A blur then does not start a second change. */
    const busy = useRef(false);
    /** True after Escape or a change. The blur that comes after it then does nothing. */
    const done = useRef(false);

    useEffect(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        const dot = isDirectory ? -1 : initial.lastIndexOf('.');
        input.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }, [initial, isDirectory]);

    const commit = async (fromBlur: boolean) => {
        if (busy.current || done.current) return;
        busy.current = true;
        const message = await onCommit(value, fromBlur);
        busy.current = false;
        if (!message) {
            done.current = true;
        } else if (fromBlur) {
            done.current = true;
            onFail(message);
        } else {
            setError(message);
        }
    };

    const Icon = isDirectory ? folderIcon(false) : fileIcon(value || initial);
    return (
        <>
            <div className="tree-row editing" style={{ paddingLeft: 8 + depth * INDENT }}>
                <span className="tree-chevron">{isDirectory && <ChevronRight size={14} strokeWidth={ICON_STROKE} />}</span>
                <Icon className="tree-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                <input
                    ref={inputRef}
                    className={inputClass('sm', { invalid: !!error, className: 'tree-edit-input' })}
                    aria-label={label}
                    aria-invalid={!!error || undefined}
                    spellCheck={false}
                    value={value}
                    onChange={event => {
                        setValue(event.target.value);
                        setError(undefined);
                    }}
                    onClick={event => event.stopPropagation()}
                    onKeyDown={event => {
                        event.stopPropagation();
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            commit(false);
                        } else if (event.key === 'Escape') {
                            event.preventDefault();
                            done.current = true;
                            onCancel();
                        }
                    }}
                    onBlur={() => commit(true)}
                />
            </div>
            {error && (
                <div className="tree-edit-error" role="alert" style={{ paddingLeft: 8 + depth * INDENT + 20 }}>
                    {error}
                </div>
            )}
        </>
    );
}

/** The file explorer: a tree of the worktree, a file name filter, a content search, and the changes of files and folders. */
export function FileExplorer({ root, activePath, onOpenFile, title, onMoved, onDeleted }: Props) {
    const [mode, setMode] = useState<Mode>('names');
    const [query, setQuery] = useState('');
    const [caseSensitive, setCaseSensitive] = useState(readCaseSensitive);
    const [children, setChildren] = useState<Map<string, FileEntry[]>>(new Map());
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [allFiles, setAllFiles] = useState<string[]>();
    const [contentResults, setContentResults] = useState<{ query: string; caseSensitive: boolean; matches: ContentMatch[]; truncated: boolean }>();
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
    const [edit, setEdit] = useState<Edit>();
    /** The folder under the pointer in a drag. An empty string is the root. */
    const [dropTarget, setDropTarget] = useState<string>();
    /** The path of the tree row that the user drags. It is undefined for files from the Finder. */
    const dragged = useRef<string | undefined>(undefined);
    /** The closed folder under the pointer in a drag. It opens after a short time. */
    const dragExpand = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);

    const loadDirectory = useCallback(
        async (directory: string) => {
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
        },
        [root]
    );

    const reloadLoaded = useCallback(
        (directories?: string[]) => {
            const loaded = [...childrenRef.current.keys()];
            for (const directory of directories ? loaded.filter(dir => directories.includes(dir)) : loaded) {
                loadDirectory(directory);
            }
        },
        [loadDirectory]
    );

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
            api.searchContents(root, query, caseSensitive)
                .then(
                    result => !cancelled && setContentResults({ query, caseSensitive, ...result }),
                    err => !cancelled && setError(errorText(err))
                )
                .finally(() => !cancelled && setSearching(false));
        }, 250);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [mode, query, caseSensitive, root]);

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

    /** Expands a folder and all its parent folders. */
    const revealFolder = (folder: string) => {
        if (!folder) return;
        const parts = folder.split('/');
        for (let index = 1; index <= parts.length; index += 1) {
            setFolderOpen(parts.slice(0, index).join('/'), true);
        }
    };

    /** Loads the folders again now. The watcher also loads them, but later. */
    const refresh = (...directories: string[]) => {
        for (const directory of new Set(directories)) {
            if (directory === '' || childrenRef.current.has(directory)) {
                loadDirectory(directory);
            }
        }
        setAllFiles(undefined);
    };

    /** Moves the open folders and the loaded folders of a renamed or moved entry to the new path. */
    const afterMove = (from: string, to: string) => {
        const target = (path: string) => (isSameOrInside(from, path) ? to + path.slice(from.length) : path);
        const stale = [...childrenRef.current.keys()].filter(directory => isSameOrInside(from, directory));
        setChildren(map => {
            const next = new Map(map);
            stale.forEach(directory => next.delete(directory));
            return next;
        });
        stale.forEach(directory => loadDirectory(target(directory)));
        setExpanded(set => new Set([...set].map(target)));
        setCursor(current => current && target(current));
        refresh(parentPath(from), parentPath(to));
        onMoved?.(from, to);
    };

    const nameMatches = useMemo(
        () => (mode === 'names' && query && allFiles ? fuzzyFilter(allFiles, query, undefined, caseSensitive) : []),
        [mode, query, allFiles, caseSensitive]
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
    // biome-ignore lint/correctness/useExhaustiveDependencies: A change of treeRows can show the cursor row. Then the effect scrolls to it.
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
            revealFolder(parentPath(activePath));
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

    const rowByPath = (path: string | undefined) => (path === undefined ? undefined : treeRows.find(row => row.path === path));

    /** The folder for a new entry: the folder of the row, or the parent folder of a file row. Without a row, the root. */
    const folderFor = (path: string | undefined): string => {
        const row = rowByPath(path);
        return !row ? '' : row.isDirectory ? row.path : row.parent;
    };

    const startCreate = (kind: 'file' | 'folder', parent: string) => {
        setQuery('');
        revealFolder(parent);
        setEdit({ kind, parent });
    };

    /**
     * Makes the change of the text field. Returns the error text when the change fails.
     * After Enter, the tree gets the keyboard focus again. After a click outside, the focus stays on the clicked element.
     */
    const commitEdit = async (current: Edit, input: string, fromBlur: boolean): Promise<string | undefined> => {
        const name = input.trim();
        const focusTree = () => {
            if (!fromBlur) treeRef.current?.focus();
        };
        if (current.kind === 'rename') {
            const to = joinPath(parentPath(current.path), name);
            if (!name || to === current.path) {
                setEdit(undefined);
                focusTree();
                return undefined;
            }
            const invalid = fileNameError(name);
            if (invalid) return invalid;
            try {
                await api.move(root, current.path, to);
            } catch (err) {
                return errorText(err);
            }
            setEdit(undefined);
            afterMove(current.path, to);
            focusTree();
            return undefined;
        }
        if (!name) {
            setEdit(undefined);
            focusTree();
            return undefined;
        }
        // A name with "/" makes subfolders, for example "src/utils/index.ts".
        const invalid = fileNameError(name, true);
        if (invalid) return invalid;
        const path = joinPath(current.parent, name);
        try {
            await (current.kind === 'file' ? api.createFile(root, path) : api.createFolder(root, path));
        } catch (err) {
            return errorText(err);
        }
        setEdit(undefined);
        refresh(current.parent);
        revealFolder(parentPath(path));
        setCursor(path);
        if (current.kind === 'file') {
            onOpenFile(path);
        } else {
            focusTree();
        }
        return undefined;
    };

    const cancelEdit = () => {
        setEdit(undefined);
        treeRef.current?.focus();
    };

    /** Asks the user, then moves a file or a folder to the Trash. */
    const remove = async (path: string) => {
        const row = rowByPath(path);
        const confirmed = await confirmDialog({
            title: `Delete "${baseName(path)}"?`,
            message: row?.isDirectory ? 'The folder and all its files go to the Trash.' : 'The file goes to the Trash.',
            confirmLabel: 'Move to Trash',
            danger: true
        });
        if (!confirmed) return;
        // After the delete, the cursor goes to the next row below the entry, or to the row above it.
        const index = treeRows.findIndex(item => item.path === path);
        const next = treeRows.slice(index + 1).find(item => !isSameOrInside(path, item.path)) ?? treeRows[index - 1];
        try {
            await api.delete(root, [path]);
        } catch (err) {
            setError(errorText(err));
            return;
        }
        setExpanded(set => new Set([...set].filter(item => !isSameOrInside(path, item))));
        setCursor(next?.path);
        refresh(parentPath(path));
        onDeleted?.([path]);
        treeRef.current?.focus();
    };

    const copyText = (text: string) => navigator.clipboard.writeText(text).catch(err => setError(errorText(err)));

    /** Opens the context menu of a row. Without a path, the menu is for the root. */
    const openMenu = async (path: string | undefined, anchor?: Element) => {
        const items: ContextMenuItem[] = [{ id: 'new-file', label: 'New file…' }, { id: 'new-folder', label: 'New folder…' }, { type: 'separator' }];
        if (path !== undefined) {
            items.push(
                { id: 'rename', label: 'Rename…' },
                { id: 'delete', label: 'Delete…', danger: true },
                { type: 'separator' },
                { id: 'copy-path', label: 'Copy path' },
                { id: 'copy-relative-path', label: 'Copy relative path' }
            );
        }
        items.push({ id: 'reveal', label: 'Reveal in Finder' });
        const choice = await showContextMenu(items, anchor);
        switch (choice) {
            case 'new-file':
            case 'new-folder':
                startCreate(choice === 'new-file' ? 'file' : 'folder', folderFor(path));
                break;
            case 'rename':
                if (path !== undefined) setEdit({ kind: 'rename', path });
                break;
            case 'delete':
                if (path !== undefined) remove(path);
                break;
            case 'copy-path':
                copyText(path ? `${root}/${path}` : root);
                break;
            case 'copy-relative-path':
                if (path !== undefined) copyText(path);
                break;
            case 'reveal':
                api.reveal(root, path ?? '').catch(err => setError(errorText(err)));
                break;
        }
    };

    const onTreeContextMenu = (event: React.MouseEvent) => {
        if (query) return;
        event.preventDefault();
        const path = rowOf(event.target)?.dataset.path;
        if (path !== undefined) setCursor(path);
        openMenu(path);
    };

    const stopDragExpand = () => {
        clearTimeout(dragExpand.current?.timer);
        dragExpand.current = undefined;
    };

    const endDrag = () => {
        dragged.current = undefined;
        setDropTarget(undefined);
        stopDragExpand();
    };

    /** The folder that gets a drop on the element: the folder of the row, the parent folder of a file row, or the root. */
    const dropFolder = (target: EventTarget | null): string => {
        const row = rowOf(target);
        if (!row) return '';
        const path = row.dataset.path ?? '';
        return row.dataset.directory === 'true' ? path : parentPath(path);
    };

    /** True when the drag can drop in the folder. A row cannot go into itself or into the folder that has it now. */
    const canDrop = (event: React.DragEvent, folder: string): boolean => {
        const source = dragged.current;
        if (source !== undefined) {
            return !isSameOrInside(source, folder) && parentPath(source) !== folder;
        }
        return event.dataTransfer.types.includes('Files');
    };

    const onDragOver = (event: React.DragEvent) => {
        if (query) return;
        const folder = dropFolder(event.target);
        if (!canDrop(event, folder)) {
            setDropTarget(undefined);
            stopDragExpand();
            return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = dragged.current !== undefined ? 'move' : 'copy';
        setDropTarget(folder);
        // A closed folder under the pointer opens after a short time, so that the drop can go deeper.
        const row = rowOf(event.target);
        const closed = row?.dataset.directory === 'true' && row.getAttribute('aria-expanded') !== 'true' ? row.dataset.path : undefined;
        if (dragExpand.current?.path !== closed) {
            stopDragExpand();
            if (closed) {
                dragExpand.current = { path: closed, timer: setTimeout(() => setFolderOpen(closed, true), DRAG_EXPAND_MS) };
            }
        }
    };

    const onDragLeave = (event: React.DragEvent) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) {
            setDropTarget(undefined);
            stopDragExpand();
        }
    };

    const onDrop = async (event: React.DragEvent) => {
        const folder = dropFolder(event.target);
        const allowed = !query && canDrop(event, folder);
        const source = dragged.current;
        // Read the files before the first await. The data of the drag is not available after the event.
        const files = source === undefined ? [...event.dataTransfer.files].map(file => api.pathForFile(file)).filter(Boolean) : [];
        endDrag();
        if (!allowed) return;
        event.preventDefault();
        if (source !== undefined) {
            const to = joinPath(folder, baseName(source));
            try {
                await api.move(root, source, to);
            } catch (err) {
                setError(errorText(err));
                return;
            }
            revealFolder(folder);
            afterMove(source, to);
            setCursor(to);
            return;
        }
        if (files.length === 0) return;
        try {
            const copied = await api.copyIn(root, files, folder);
            refresh(folder);
            revealFolder(folder);
            setCursor(copied[0]);
        } catch (err) {
            setError(errorText(err));
            refresh(folder);
        }
    };

    const onTreeKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
        // The keys of the text field of a rename do not move the cursor.
        if (event.target !== event.currentTarget) {
            return;
        }
        const row = rowByPath(cursor);
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
            event.preventDefault();
            openMenu(row?.path, row ? (treeRef.current?.querySelector('.tree-row.cursor') ?? undefined) : undefined);
            return;
        }
        if (row && event.key === 'F2' && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            setEdit({ kind: 'rename', path: row.path });
            return;
        }
        if (row && (event.key === 'Delete' || (event.key === 'Backspace' && event.metaKey))) {
            event.preventDefault();
            remove(row.path);
            return;
        }
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

    const editRow = (depth: number, isDirectory: boolean, initial: string, label: string) =>
        edit && (
            <EditRow
                key={edit.kind === 'rename' ? edit.path : `new:${edit.parent}`}
                depth={depth}
                isDirectory={isDirectory}
                initial={initial}
                label={label}
                onCommit={(name, fromBlur) => commitEdit(edit, name, fromBlur)}
                onCancel={cancelEdit}
                onFail={message => {
                    setEdit(undefined);
                    setError(message);
                }}
            />
        );

    const newRow = (depth: number) =>
        edit && edit.kind !== 'rename' ? editRow(depth, edit.kind === 'folder', '', edit.kind === 'file' ? 'New file name' : 'New folder name') : null;

    const renderTree = () => (
        <div ref={treeRef} className="explorer-tree" role="tree" aria-label="Files" tabIndex={0} onFocus={onTreeFocus} onKeyDown={onTreeKey}>
            {edit?.kind !== 'rename' && edit?.parent === '' && newRow(0)}
            {treeRows.map(({ entry, depth, open }) => {
                if (edit?.kind === 'rename' && edit.path === entry.path) {
                    return editRow(depth, entry.isDirectory, entry.name, `New name of ${entry.name}`);
                }
                const Icon = entry.isDirectory ? folderIcon(open) : fileIcon(entry.name);
                const dropInside = dropTarget !== undefined && dropTarget !== '' && isSameOrInside(dropTarget, entry.path);
                return (
                    <Fragment key={entry.path}>
                        <div
                            role="treeitem"
                            aria-expanded={entry.isDirectory ? open : undefined}
                            aria-selected={entry.path === cursor}
                            data-path={entry.path}
                            data-directory={entry.isDirectory}
                            className={`tree-row${entry.ignored ? ' ignored' : ''}${entry.path === activePath ? ' active' : ''}${entry.path === cursor ? ' cursor' : ''}${dropInside ? ' drop-inside' : ''}`}
                            style={{ paddingLeft: 8 + depth * INDENT }}
                            title={entry.path}
                            draggable={!edit}
                            onDragStart={event => {
                                dragged.current = entry.path;
                                event.dataTransfer.effectAllowed = 'move';
                                event.dataTransfer.setData('text/plain', `${root}/${entry.path}`);
                            }}
                            onDragEnd={endDrag}
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
                        {open && edit?.kind !== 'rename' && edit?.parent === entry.path && newRow(depth + 1)}
                    </Fragment>
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
    const results: { path: string; line?: number }[] = useMemo(
        () =>
            mode === 'names'
                ? nameMatches.map(({ path }) => ({ path }))
                : contentGroups.flatMap(([path, matches]) => matches.map(match => ({ path, line: match.line }))),
        [mode, nameMatches, contentGroups]
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: New results select the first result again.
    useEffect(() => setActive(0), [results]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: The selected row changes when active changes. Then the effect scrolls to it.
    useEffect(() => {
        bodyRef.current?.querySelector('.search-result.selected')?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    const flipMode = () => setMode(current => (current === 'names' ? 'contents' : 'names'));
    const toggleCase = () =>
        setCaseSensitive(current => {
            saveCaseSensitive(!current);
            return !current;
        });
    const onSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Tab' && event.altKey) {
            // ⌥Tab changes between names and contents. The query stays.
            event.preventDefault();
            flipMode();
        } else if (event.code === 'KeyC' && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
            // ⌥C turns case sensitivity on or off. Without preventDefault, macOS types "ç".
            event.preventDefault();
            toggleCase();
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
        <div className="search-summary">
            {count}
            {more ? '+' : ''} {count === 1 ? 'match' : 'matches'} in {mode === 'names' ? 'file names' : 'file contents'}
        </div>
    );

    const renderNameMatches = () => {
        if (!allFiles) {
            return <SkeletonRows count={6} dot={false} label="Loading files" />;
        }
        if (nameMatches.length === 0) {
            return <div className="explorer-message">No files match "{query}".</div>;
        }
        return (
            <>
                {summary(nameMatches.length)}
                {nameMatches.map(({ path }, index) => {
                    const Icon = fileIcon(baseName(path));
                    const positions = fuzzyPositions(path, query, caseSensitive);
                    const nameStart = path.lastIndexOf('/') + 1;
                    return (
                        <div
                            key={path}
                            className={`search-result search-name${index === active ? ' selected' : ''}`}
                            title={path}
                            onMouseMove={() => index !== active && setActive(index)}
                            onClick={() => onOpenFile(path)}
                        >
                            <Icon className="tree-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                            <span className="search-file-name">{markPositions(baseName(path), positions, nameStart)}</span>
                            <span className="search-file-path">{markPositions(parentPath(path), positions, 0)}</span>
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
                        <button className="search-group-head" title={path} onClick={() => onOpenFile(path, matches[0].line)}>
                            <span className="search-file-name">{baseName(path)}</span>
                            <span className="search-file-path">{parentPath(path)}</span>
                            <Count className="search-count" value={matches.length} label={pluralize(matches.length, 'match', 'matches')} />
                        </button>
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
                                    <span className="search-text" title={match.text.trim()}>
                                        {highlight(
                                            matchLine(match.text, contentResults.query, contentResults.caseSensitive),
                                            contentResults.query,
                                            contentResults.caseSensitive
                                        )}
                                    </span>
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
                <span className="explorer-title" title={root}>
                    {title ?? baseName(root)}
                </span>
                <IconButton
                    size="sm"
                    icon={<FilePlus size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} />}
                    label="New file"
                    onClick={() => startCreate('file', folderFor(cursor))}
                />
                <IconButton
                    size="sm"
                    icon={<FolderPlus size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} />}
                    label="New folder"
                    onClick={() => startCreate('folder', folderFor(cursor))}
                />
                <IconButton
                    size="sm"
                    icon={<ListCollapse size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} />}
                    label="Collapse all folders"
                    onClick={() => setExpanded(new Set())}
                />
                <IconButton
                    size="sm"
                    icon={<RefreshCw size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} />}
                    label="Refresh"
                    onClick={() => {
                        reloadLoaded();
                        setAllFiles(undefined);
                    }}
                />
            </div>

            <div className="explorer-controls">
                <Input
                    ref={inputRef}
                    value={query}
                    placeholder={mode === 'names' ? 'Filter files' : 'Search in files'}
                    spellCheck={false}
                    onChange={event => setQuery(event.target.value)}
                    onKeyDown={onSearchKey}
                    icon={<Search size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} />}
                    suffix={
                        <>
                            <button
                                type="button"
                                className={`search-case${caseSensitive ? ' selected' : ''}`}
                                aria-pressed={caseSensitive}
                                title={caseSensitive ? 'Match case: on (⌥C)' : 'Match case: off (⌥C)'}
                                onClick={toggleCase}
                            >
                                <CaseSensitive size={16} strokeWidth={1.6} />
                            </button>
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
                        </>
                    }
                />
            </div>

            <div
                className={`explorer-body${dropTarget === '' ? ' drop-root' : ''}`}
                ref={bodyRef}
                onContextMenu={onTreeContextMenu}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
            >
                {error && (
                    <ErrorBanner className="explorer-message error" onClose={() => setError(undefined)}>
                        {error}
                    </ErrorBanner>
                )}
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
