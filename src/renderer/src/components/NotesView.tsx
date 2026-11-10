import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronRight, Copy, Folder, FolderInput, FolderOpen, FolderPlus, NotebookPen, Pencil, Plus, Search, Tag, Trash2, X } from 'lucide-react';
import {
    folderBaseName,
    folderMoveTargets,
    folderNameError,
    isInFolder,
    joinNotePath,
    noteMatches,
    noteNameError,
    normalizeTags,
    parentFolder,
    splitNotePath,
    tagOptions,
    uniqueNoteName,
    type NoteInfo
} from '@shared/notes';
import { monaco } from '../editor/monaco';
import { fileIcon } from '../files/file-icons';
import { treeKeyAction, type TreeRow } from '../files/tree-nav';
import { itemKeys } from '../keyboard/list-nav';
import { errorText, timeAgo } from '../util';
import { ResizeHandle, usePanelWidth } from './ResizeHandle';
import { confirmDialog } from './ConfirmDialog';

const api = window.shipwarden.notes;
const SELECTED_KEY = 'shipwarden.note';
const SAVE_DELAY_MS = 500;

function readSelected(): string | undefined {
    try {
        return localStorage.getItem(SELECTED_KEY) ?? undefined;
    } catch {
        return undefined;
    }
}

function writeSelected(name: string | undefined): void {
    try {
        if (name) localStorage.setItem(SELECTED_KEY, name);
        else localStorage.removeItem(SELECTED_KEY);
    } catch {
        // The selection stays for this session only.
    }
}

/**
 * An input for a note name or a folder name. It selects the name without the extension, so the user can type a new
 * name at once.
 */
function NameInput({
    initial,
    onSubmit,
    onCancel,
    validate = noteNameError,
    placeholder = 'name.ext'
}: {
    initial: string;
    onSubmit(name: string): Promise<void>;
    onCancel(): void;
    validate?(name: string): string | undefined;
    placeholder?: string;
}) {
    const [value, setValue] = useState(initial);
    const [error, setError] = useState<string>();
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => {
        const input = ref.current;
        if (!input) return;
        input.focus();
        const dot = initial.lastIndexOf('.');
        input.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }, [initial]);

    const submit = async () => {
        const problem = validate(value);
        if (problem) {
            setError(problem);
            return;
        }
        try {
            await onSubmit(value.trim());
        } catch (err) {
            setError(errorText(err));
        }
    };
    return (
        <div className="note-name-input">
            <input
                ref={ref}
                className="settings-input mono"
                value={value}
                spellCheck={false}
                placeholder={placeholder}
                onChange={event => {
                    setValue(event.target.value);
                    setError(undefined);
                }}
                onKeyDown={event => {
                    if (event.key === 'Enter') void submit();
                    if (event.key === 'Escape') onCancel();
                }}
                onBlur={() => !error && onCancel()}
            />
            {error && <div className="form-error">{error}</div>}
        </div>
    );
}

/** The width of the tag picker popover, in pixels. The CSS has the same value. */
const POPOVER_WIDTH = 260;

/** The "Add tag" button. It opens a combobox with the tags of the other notes and an option to create a new tag. */
function TagPicker({ tags, allTags, onAdd, onRemoveLast }: { tags: string[]; allTags: string[]; onAdd(tag: string): void; onRemoveLast(): void }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    /** True when the popover opens to the left of the button, because the window has no space at the right. */
    const [alignRight, setAlignRight] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const options = tagOptions(query, tags, allTags);

    useEffect(() => {
        if (!open) return;
        const onDown = (event: MouseEvent) => {
            if (!root.current?.contains(event.target as Node)) setOpen(false);
        };
        window.addEventListener('mousedown', onDown);
        return () => window.removeEventListener('mousedown', onDown);
    }, [open]);
    useEffect(() => setActive(0), [query]);

    const choose = (tag: string) => {
        onAdd(tag);
        // The picker stays open, so the user can add more tags.
        setQuery('');
    };
    const onKey = (event: React.KeyboardEvent) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive(index => Math.min(options.length - 1, index + 1));
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(index => Math.max(0, index - 1));
        } else if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            const option = options[active];
            if (option) choose(option.tag);
        } else if (event.key === 'Escape' || (event.key === 'Tab' && event.shiftKey)) {
            // Escape closes only the popover, not a dialog around it. Shift+Tab also closes it.
            // The focus goes back to the button. After Tab, `onBlur` closes the popover.
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            trigger.current?.focus();
        } else if (event.key === 'Backspace' && !query && tags.length) {
            onRemoveLast();
        }
    };

    return (
        <div
            className="tag-picker"
            ref={root}
            onBlur={event => {
                // A click on an option gives no new focus. Only a focus outside the picker closes the popover.
                if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
            }}
        >
            <button
                ref={trigger}
                className={`note-tag-add${open ? ' on' : ''}`}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => {
                    setQuery('');
                    const left = root.current?.getBoundingClientRect().left ?? 0;
                    setAlignRight(left + POPOVER_WIDTH > window.innerWidth - 12);
                    setOpen(value => !value);
                }}
            >
                <Plus size={12} strokeWidth={2} /> Add tag
            </button>
            {open && (
                <div className={`combobox-popover tag-picker-popover${alignRight ? ' align-right' : ''}`}>
                    <label className="combobox-search">
                        <Tag size={13} strokeWidth={1.6} />
                        <input
                            autoFocus
                            value={query}
                            placeholder="Find or create a tag"
                            spellCheck={false}
                            onChange={event => setQuery(event.target.value)}
                            onKeyDown={onKey}
                        />
                    </label>
                    <div className="combobox-list" role="listbox">
                        {options.length === 0 && (
                            <div className="combobox-empty">
                                {allTags.length ? 'No other tags. Type to create one.' : 'Type a name to create the first tag.'}
                            </div>
                        )}
                        {options.map((option, index) => (
                            <div
                                key={`${option.create}-${option.tag}`}
                                role="option"
                                aria-selected={index === active}
                                className={`combobox-option${index === active ? ' active' : ''}`}
                                onMouseMove={() => setActive(index)}
                                onMouseDown={event => event.preventDefault()}
                                onClick={() => choose(option.tag)}
                            >
                                {option.create ? (
                                    <span className="combobox-label">
                                        Create tag <strong>#{option.tag}</strong>
                                    </span>
                                ) : (
                                    <span className="combobox-label">#{option.tag}</span>
                                )}
                                {option.create && <Plus size={13} strokeWidth={2} />}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

/** The tags of a note: chips with a remove button, and the "Add tag" button. */
function TagEditor({ tags, allTags, onChange }: { tags: string[]; allTags: string[]; onChange(tags: string[]): void }) {
    return (
        <div className="note-tags">
            {tags.map(tag => (
                <span key={tag} className="note-tag">
                    #{tag}
                    <button title={`Remove the tag ${tag}`} onClick={() => onChange(tags.filter(item => item !== tag))}>
                        <X size={11} strokeWidth={2} />
                    </button>
                </span>
            ))}
            <TagPicker tags={tags} allTags={allTags} onAdd={tag => onChange(normalizeTags([...tags, tag]))} onRemoveLast={() => onChange(tags.slice(0, -1))} />
        </div>
    );
}

interface EditorProps {
    note: NoteInfo;
    /** The notes folder on disk, for "Copy path". */
    folder: string;
    /** The folders of the notes, for "Move to folder". */
    folders: string[];
    allTags: string[];
    onRenamed(name: string): void;
    onDeleted(): void;
    onTags(tags: string[]): void;
}

/** One note in Monaco. The language comes from the extension. Changes save after a short pause, and when the note closes. */
function NoteEditor({ note, folder, folders, allTags, onRenamed, onDeleted, onTags }: EditorProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const modelRef = useRef<monaco.editor.ITextModel | undefined>(undefined);
    const dirty = useRef(false);
    const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [state, setState] = useState<'loading' | 'saved' | 'saving' | 'edited'>('loading');
    const [error, setError] = useState<string>();
    const [renaming, setRenaming] = useState(false);

    /** Writes the editor text to the file when it has changes. */
    const flush = useCallback(async () => {
        clearTimeout(saveTimer.current);
        const model = modelRef.current;
        if (!model || !dirty.current) return;
        dirty.current = false;
        setState('saving');
        try {
            await api.write(note.name, model.getValue());
            setState(current => (current === 'saving' ? 'saved' : current));
        } catch (err) {
            dirty.current = true;
            setError(errorText(err));
            setState('edited');
        }
    }, [note.name]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        let disposed = false;
        // The "note" scheme keeps the language servers of the worktrees away from notes.
        const model = monaco.editor.createModel('', undefined, monaco.Uri.from({ scheme: 'note', path: `/${note.name}` }));
        const prose = ['markdown', 'plaintext'].includes(model.getLanguageId());
        const editor = monaco.editor.create(container, {
            model,
            theme: 'shipwarden',
            automaticLayout: true,
            fontFamily: '"JetBrains Mono", Menlo, monospace',
            fontSize: 13,
            lineHeight: 20,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            padding: { top: 10 },
            wordWrap: prose ? 'on' : 'off',
            readOnly: true
        });
        modelRef.current = model;
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void flush());
        const changes = model.onDidChangeContent(event => {
            if (event.isFlush) return;
            dirty.current = true;
            setState('edited');
            clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
        });
        api.read(note.name).then(
            content => {
                if (disposed) return;
                model.setValue(content);
                editor.updateOptions({ readOnly: false });
                setState('saved');
                editor.focus();
            },
            err => !disposed && setError(errorText(err))
        );

        return () => {
            disposed = true;
            // Save the last changes before the editor goes away.
            if (dirty.current) void api.write(note.name, model.getValue());
            clearTimeout(saveTimer.current);
            changes.dispose();
            editor.dispose();
            model.dispose();
            modelRef.current = undefined;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [note.name]);

    // Another app or an agent changed the file: show the new text when the editor has no unsaved changes.
    useEffect(() => {
        const model = modelRef.current;
        if (!model || dirty.current || state === 'loading') return;
        api.read(note.name).then(
            content => {
                if (!dirty.current && modelRef.current === model && content !== model.getValue()) {
                    model.setValue(content);
                }
            },
            () => undefined
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [note.modifiedAt]);

    /** Renames the file. The note stays in its folder. */
    const rename = async (fileName: string) => {
        if (fileName === note.fileName) {
            setRenaming(false);
            return;
        }
        await flush();
        const renamed = await api.rename(note.name, joinNotePath(note.folder, fileName));
        setRenaming(false);
        onRenamed(renamed.name);
    };
    /** Moves the note to another folder, or to the top level with an empty folder. */
    const move = async (target: string) => {
        if (target === note.folder) return;
        try {
            await flush();
            const moved = await api.rename(note.name, joinNotePath(target, note.fileName));
            onRenamed(moved.name);
        } catch (err) {
            setError(errorText(err));
        }
    };
    const remove = async () => {
        if (!(await confirmDialog({ title: `Move the note "${note.fileName}" to the Trash?`, confirmLabel: 'Move to Trash', danger: true }))) return;
        clearTimeout(saveTimer.current);
        dirty.current = false;
        try {
            await api.delete(note.name);
            onDeleted();
        } catch (err) {
            setError(errorText(err));
        }
    };
    const path = `${folder}/${note.name}`;

    return (
        <div className="note-pane">
            <header className="note-header">
                <div className="note-title-row">
                    {note.folder && (
                        <span className="note-title-folder" title={note.folder}>
                            <Folder size={13} strokeWidth={1.6} />
                            {note.folder.split('/').join(' / ')} /
                        </span>
                    )}
                    {renaming ? (
                        <NameInput initial={note.fileName} onSubmit={rename} onCancel={() => setRenaming(false)} />
                    ) : (
                        <button className="note-title" title="Rename the note" onClick={() => setRenaming(true)}>
                            {note.fileName}
                        </button>
                    )}
                    <span className={`note-state ${state}`}>
                        {state === 'saving' ? 'Saving…' : state === 'edited' ? 'Edited' : state === 'saved' ? 'Saved' : ''}
                    </span>
                    <span className="header-spacer" />
                    <label className="note-move" title="Move to a folder">
                        <FolderInput size={14} strokeWidth={1.6} />
                        <select value={note.folder} onChange={event => void move(event.target.value)}>
                            <option value="">No folder</option>
                            {folders.map(item => (
                                <option key={item} value={item}>
                                    {'\u00a0\u00a0'.repeat(item.split('/').length - 1)}
                                    {item.slice(item.lastIndexOf('/') + 1)}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button className="icon-button" title={`Copy the path: ${path}`} onClick={() => void navigator.clipboard.writeText(path)}>
                        <Copy size={14} strokeWidth={1.6} />
                    </button>
                    <button className="icon-button" title="Reveal in Finder" onClick={() => api.reveal(note.name)}>
                        <FolderOpen size={14} strokeWidth={1.6} />
                    </button>
                    <button className="icon-button" title="Move to the Trash" onClick={() => void remove()}>
                        <Trash2 size={14} strokeWidth={1.6} />
                    </button>
                </div>
                <TagEditor tags={note.tags} allTags={allTags} onChange={onTags} />
                {error && <div className="form-error">{error}</div>}
            </header>
            <div className="note-editor" ref={containerRef} />
        </div>
    );
}

const COLLAPSED_KEY = 'shipwarden.notesCollapsed';
/** The drag data type of a note row. The value is the path of the note. */
const NOTE_DRAG_TYPE = 'application/x-shipwarden-note';
/** The drag data type of a folder row. The value is the path of the folder. */
const FOLDER_DRAG_TYPE = 'application/x-shipwarden-folder';

function readCollapsed(): Set<string> {
    try {
        const value = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
        return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
    } catch {
        return new Set();
    }
}

function writeCollapsed(value: Set<string>): void {
    try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...value]));
    } catch {
        // The state stays for this session only.
    }
}

/** Replaces the folder part `from` of a path with `to`: for a renamed or moved folder. Other paths do not change. */
function movedPath(value: string, from: string, to: string): string {
    if (value === from) return to;
    return value.startsWith(`${from}/`) ? `${to}${value.slice(from.length)}` : value;
}

/** The depth of a folder path: "a" is 1, "a/b" is 2. The top level ("") is 0. */
const depthOf = (folder: string) => (folder ? folder.split('/').length : 0);

/** What the list creates or renames now. */
type Editing = { kind: 'note'; folder: string; name: string } | { kind: 'folder'; parent: string } | { kind: 'renameFolder'; folder: string };

/**
 * The Notes view: local files with any extension that are available in all projects, like the scratch files of
 * JetBrains IDEs. Each note has a name (the file name) and tags. A note can be at the top level or in a folder, and
 * folders can be in folders. The files are in ~/.shipwarden/notes, and each folder is a folder there.
 */
export function NotesView() {
    const [notes, setNotes] = useState<NoteInfo[]>();
    const [folders, setFolders] = useState<string[]>([]);
    const [folder, setFolder] = useState('');
    const [error, setError] = useState<string>();
    const [query, setQuery] = useState('');
    const [tagFilter, setTagFilter] = useState<string[]>([]);
    const [selected, setSelected] = useState<string | undefined>(readSelected);
    const [editing, setEditing] = useState<Editing>();
    const [collapsed, setCollapsed] = useState(readCollapsed);
    /** The folder under a dragged note or folder: a folder path, or "" for the top level. */
    const [dropTarget, setDropTarget] = useState<string>();
    const listWidth = usePanelWidth('shipwarden.width.notesList', 300, 220, 520);

    const load = useCallback(async () => {
        try {
            const [list, folderList] = await Promise.all([api.list(), api.folders()]);
            setNotes(list);
            setFolders(folderList);
            setError(undefined);
        } catch (err) {
            setError(errorText(err));
        }
    }, []);
    useEffect(() => {
        void load();
        api.folder().then(setFolder, () => undefined);
        return api.onChanged(() => void load());
    }, [load]);

    const select = (name: string | undefined) => {
        setSelected(name);
        writeSelected(name);
    };
    /** Opens a folder and its parents, or closes one folder. */
    const setFolderOpen = (path: string, open: boolean) => {
        setCollapsed(current => {
            const next = new Set(current);
            if (open) {
                for (let item = path; item; item = parentFolder(item)) next.delete(item);
            } else {
                next.add(path);
            }
            writeCollapsed(next);
            return next;
        });
    };
    /** Keeps the open state and the selected note when a folder gets a new path. */
    const followFolder = (from: string, to: string) => {
        setCollapsed(current => {
            const next = new Set([...current].map(item => movedPath(item, from, to)));
            writeCollapsed(next);
            return next;
        });
        if (selected) select(movedPath(selected, from, to));
    };

    const allTags = useMemo(() => {
        const counts = new Map<string, number>();
        for (const note of notes ?? []) {
            for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
    }, [notes]);
    const filtering = query.trim() !== '' || tagFilter.length > 0;
    const shown = (notes ?? []).filter(note => noteMatches(note, query, tagFilter));
    const current = notes?.find(note => note.name === selected);

    const startNote = (inFolder: string) => {
        const existing = (notes ?? []).filter(note => note.folder === inFolder).map(note => note.fileName);
        if (inFolder) setFolderOpen(inFolder, true);
        setEditing({ kind: 'note', folder: inFolder, name: uniqueNoteName('scratch.md', existing) });
    };
    const startFolder = (parent: string) => {
        if (parent) setFolderOpen(parent, true);
        setEditing({ kind: 'folder', parent });
    };
    const create = async (inFolder: string, fileName: string) => {
        const note = await api.create(joinNotePath(inFolder, fileName));
        setEditing(undefined);
        await load();
        select(note.name);
    };
    const createFolder = async (parent: string, name: string) => {
        await api.createFolder(joinNotePath(parent, name));
        setEditing(undefined);
        await load();
    };
    const renameFolder = async (from: string, name: string) => {
        const to = joinNotePath(parentFolder(from), name);
        if (from !== to) {
            const renamed = await api.renameFolder(from, to);
            followFolder(from, renamed);
        }
        setEditing(undefined);
        await load();
    };
    const deleteFolder = async (path: string) => {
        const count = (notes ?? []).filter(note => isInFolder(note.folder, path)).length;
        const inner = folders.filter(item => item.startsWith(`${path}/`)).length;
        const parts = [count ? `${count} ${count === 1 ? 'note' : 'notes'}` : '', inner ? `${inner} ${inner === 1 ? 'folder' : 'folders'}` : ''].filter(
            Boolean
        );
        const ok = await confirmDialog({
            title: `Move the folder "${folderBaseName(path)}" to the Trash?`,
            message: parts.length ? `Its ${parts.join(' and ')} go to the Trash too. You can get them back from the Trash.` : 'The folder is empty.',
            confirmLabel: 'Move to Trash',
            danger: true
        });
        if (!ok) return;
        try {
            await api.deleteFolder(path);
            if (selected && isInFolder(splitNotePath(selected).folder, path)) select(undefined);
            await load();
        } catch (err) {
            setError(errorText(err));
        }
    };
    /** Moves a dragged note to a folder, or to the top level with "". */
    const moveNote = async (notePath: string, target: string) => {
        const note = notes?.find(item => item.name === notePath);
        if (!note || note.folder === target) return;
        try {
            const moved = await api.rename(note.name, joinNotePath(target, note.fileName));
            if (selected === note.name) select(moved.name);
            if (target) setFolderOpen(target, true);
            await load();
        } catch (err) {
            setError(errorText(err));
        }
    };
    /** Moves a dragged folder into another folder, or to the top level with "". */
    const moveFolder = async (source: string, target: string) => {
        if (parentFolder(source) === target || isInFolder(target, source)) return;
        try {
            const moved = await api.renameFolder(source, joinNotePath(target, folderBaseName(source)));
            followFolder(source, moved);
            if (target) setFolderOpen(target, true);
            await load();
        } catch (err) {
            setError(errorText(err));
        }
    };
    const dropProps = (target: string) => ({
        onDragOver: (event: React.DragEvent) => {
            const types = event.dataTransfer.types;
            if (!types.includes(NOTE_DRAG_TYPE) && !types.includes(FOLDER_DRAG_TYPE)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            if (dropTarget !== target) setDropTarget(target);
        },
        onDrop: (event: React.DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            setDropTarget(undefined);
            const notePath = event.dataTransfer.getData(NOTE_DRAG_TYPE);
            const folderPath = event.dataTransfer.getData(FOLDER_DRAG_TYPE);
            if (notePath) void moveNote(notePath, target);
            else if (folderPath) void moveFolder(folderPath, target);
        }
    });

    const toggleTag = (tag: string) => setTagFilter(list => (list.includes(tag) ? list.filter(item => item !== tag) : [...list, tag]));
    const setTags = async (note: NoteInfo, tags: string[]) => {
        setNotes(list => list?.map(item => (item.name === note.name ? { ...item, tags } : item)));
        try {
            await api.setTags(note.name, tags);
        } catch (err) {
            setError(errorText(err));
            void load();
        }
    };

    const indent = (depth: number) => ({ '--note-depth': depth }) as CSSProperties;
    /** The keys of the rows in the tree. A folder key and a note key cannot be equal. */
    const folderKey = (path: string) => `folder:${path}`;
    const noteKey = (name: string) => `note:${name}`;
    /**
     * Moves the focus in the tree of folders and notes, in the order of the rows.
     * Right opens a folder. Left closes a folder, or moves to the parent folder.
     */
    const treeKeys = (event: React.KeyboardEvent<HTMLElement>) => {
        const cursor = (event.target as HTMLElement).dataset.treeKey;
        if (cursor === undefined || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-tree-key]')];
        const rows: TreeRow[] = elements.map(element => ({
            path: element.dataset.treeKey!,
            isDirectory: element.dataset.treeFolder !== undefined,
            open: element.getAttribute('aria-expanded') === 'true',
            parent: element.dataset.treeParent ?? ''
        }));
        const action = treeKeyAction(rows, cursor, event.key);
        if (!action) return;
        event.preventDefault();
        if (action.kind === 'move') {
            const element = elements.find(item => item.dataset.treeKey === action.path);
            element?.focus();
            element?.scrollIntoView({ block: 'nearest' });
        } else if ((action.kind === 'expand' || action.kind === 'collapse') && !filtering) {
            setFolderOpen(action.path.slice('folder:'.length), action.kind === 'expand');
        }
    };
    const noteRow = (note: NoteInfo) => {
        const Icon = fileIcon(note.fileName);
        return (
            <button
                key={note.name}
                className={`note-row${note.name === selected ? ' selected' : ''}`}
                style={indent(depthOf(note.folder))}
                data-tree-key={noteKey(note.name)}
                data-tree-parent={note.folder ? folderKey(note.folder) : ''}
                draggable
                onDragStart={event => {
                    event.dataTransfer.setData(NOTE_DRAG_TYPE, note.name);
                    event.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => setDropTarget(undefined)}
                onClick={() => select(note.name)}
            >
                <Icon size={15} strokeWidth={1.5} className="tree-icon" />
                <span className="note-row-main">
                    <span className="note-row-name">{note.fileName}</span>
                    <span className="note-row-meta">
                        {note.tags.map(tag => (
                            <span key={tag} className="note-row-tag">
                                #{tag}
                            </span>
                        ))}
                        <span>{timeAgo(note.modifiedAt)}</span>
                    </span>
                </span>
            </button>
        );
    };
    /** The inputs for a new note and a new folder in a folder ("" for the top level). */
    const inputs = (inFolder: string) => (
        <>
            {editing?.kind === 'folder' && editing.parent === inFolder && (
                <div className="note-indented-input" style={indent(depthOf(inFolder))}>
                    <NameInput
                        initial="New folder"
                        validate={folderNameError}
                        placeholder="Folder name"
                        onSubmit={name => createFolder(inFolder, name)}
                        onCancel={() => setEditing(undefined)}
                    />
                </div>
            )}
            {editing?.kind === 'note' && editing.folder === inFolder && (
                <div className="note-indented-input" style={indent(depthOf(inFolder))}>
                    <NameInput initial={editing.name} onSubmit={name => create(inFolder, name)} onCancel={() => setEditing(undefined)} />
                </div>
            )}
        </>
    );

    /** A folder with its folders and notes. While a search or a tag filter is on, only folders with matches show, open. */
    const folderNode = (path: string): React.ReactNode => {
        const subtree = shown.filter(note => isInFolder(note.folder, path));
        if (filtering && subtree.length === 0) return null;
        const open = filtering || !collapsed.has(path);
        const depth = depthOf(path) - 1;
        const children = folders.filter(item => parentFolder(item) === path);
        const direct = shown.filter(note => note.folder === path);
        const name = folderBaseName(path);
        const adding = (editing?.kind === 'note' && editing.folder === path) || (editing?.kind === 'folder' && editing.parent === path);
        const empty = children.length === 0 && direct.length === 0 && !adding;
        return (
            <div key={path} className={`note-folder${dropTarget === path ? ' drop' : ''}`} {...dropProps(path)}>
                {editing?.kind === 'renameFolder' && editing.folder === path ? (
                    <div className="note-indented-input" style={indent(depth)}>
                        <NameInput
                            initial={name}
                            validate={folderNameError}
                            placeholder="Folder name"
                            onSubmit={value => renameFolder(path, value)}
                            onCancel={() => setEditing(undefined)}
                        />
                    </div>
                ) : (
                    <div
                        className="note-folder-header"
                        style={indent(depth)}
                        title={path}
                        tabIndex={0}
                        role="button"
                        aria-expanded={open}
                        aria-label={`Folder ${name}`}
                        data-nav-item
                        data-tree-key={folderKey(path)}
                        data-tree-folder
                        data-tree-parent={parentFolder(path) ? folderKey(parentFolder(path)) : ''}
                        onKeyDown={itemKeys(() => !filtering && setFolderOpen(path, !open))}
                        draggable
                        onDragStart={event => {
                            event.dataTransfer.setData(FOLDER_DRAG_TYPE, path);
                            event.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={() => setDropTarget(undefined)}
                        onClick={() => !filtering && setFolderOpen(path, !open)}
                    >
                        <ChevronRight size={13} strokeWidth={1.8} className={`group-chevron${open ? ' open' : ''}`} />
                        <Folder size={14} strokeWidth={1.6} className="note-folder-icon" />
                        <span className="note-folder-name">{name}</span>
                        <span className="note-folder-count">{subtree.length}</span>
                        <span className="note-folder-actions" onClick={event => event.stopPropagation()}>
                            <button className="icon-button" title={`New note in ${name}`} onClick={() => startNote(path)}>
                                <Plus size={13} strokeWidth={1.8} />
                            </button>
                            <button className="icon-button" title={`New folder in ${name}`} onClick={() => startFolder(path)}>
                                <FolderPlus size={13} strokeWidth={1.8} />
                            </button>
                            <button className="icon-button" title="Rename the folder" onClick={() => setEditing({ kind: 'renameFolder', folder: path })}>
                                <Pencil size={12} strokeWidth={1.8} />
                            </button>
                            {/* The keyboard alternative to a drag of the folder. */}
                            <label className="note-move note-folder-move" title="Move the folder to a folder">
                                <FolderInput size={13} strokeWidth={1.8} />
                                <select
                                    aria-label={`Move ${name} to a folder`}
                                    value={parentFolder(path)}
                                    onChange={event => void moveFolder(path, event.target.value)}
                                >
                                    <option value="">Top level</option>
                                    {folderMoveTargets(folders, path).map(item => (
                                        <option key={item} value={item}>
                                            {'\u00a0\u00a0'.repeat(item.split('/').length - 1)}
                                            {folderBaseName(item)}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <button className="icon-button" title="Move the folder to the Trash" onClick={() => void deleteFolder(path)}>
                                <Trash2 size={12} strokeWidth={1.8} />
                            </button>
                        </span>
                    </div>
                )}
                {open && (
                    <>
                        {inputs(path)}
                        {children.map(folderNode)}
                        {direct.map(noteRow)}
                        {empty && !filtering && (
                            <div className="note-folder-empty" style={indent(depth + 1)}>
                                Empty. Drag a note or a folder here, or use the + buttons.
                            </div>
                        )}
                    </>
                )}
            </div>
        );
    };
    const rootFolders = folders.filter(item => !item.includes('/'));
    const topLevel = shown.filter(note => !note.folder);
    const shownRootFolders = rootFolders.filter(path => !filtering || shown.some(note => isInFolder(note.folder, path)));

    return (
        <div className="notes-view">
            <header className="tasks-header">
                <div className="tasks-header-group where">
                    <NotebookPen size={16} strokeWidth={1.7} />
                    <h1 className="notes-heading">Notes</h1>
                    <label className="tasks-search">
                        <Search size={14} strokeWidth={1.6} />
                        <input
                            value={query}
                            placeholder="Search names, folders and #tags"
                            spellCheck={false}
                            onChange={event => setQuery(event.target.value)}
                        />
                    </label>
                </div>
                <div className="tasks-header-group how">
                    <span className="header-spacer" />
                    <button className="icon-button" title={`Open the notes folder: ${folder}`} onClick={() => api.reveal()}>
                        <FolderOpen size={15} strokeWidth={1.6} />
                    </button>
                    <button className="button notes-new" title="Make a folder at the top level" onClick={() => startFolder('')}>
                        <FolderPlus size={14} strokeWidth={1.8} /> New folder
                    </button>
                    <button className="button primary notes-new" onClick={() => startNote('')}>
                        <Plus size={14} strokeWidth={2} /> New note
                    </button>
                </div>
            </header>

            <div className="notes-body" style={{ '--notes-list-width': `${listWidth.width}px` } as CSSProperties}>
                <div
                    className={`notes-list${dropTarget === '' ? ' drop-top' : ''}`}
                    {...dropProps('')}
                    onKeyDown={treeKeys}
                    onDragLeave={event => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(undefined);
                    }}
                >
                    {allTags.length > 0 && (
                        <div className="notes-tag-filter">
                            {allTags.map(([tag, count]) => (
                                <button key={tag} className={`note-tag filter${tagFilter.includes(tag) ? ' on' : ''}`} onClick={() => toggleTag(tag)}>
                                    #{tag} <span>{count}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    {editing?.kind === 'folder' && editing.parent === '' && inputs('')}
                    {error && <div className="form-error task-list-error">{error}</div>}
                    {!notes && !error && <div className="panel-message">Loading notes…</div>}
                    {notes?.length === 0 && folders.length === 0 && !editing && (
                        <div className="panel-message notes-empty">
                            <p>No notes yet.</p>
                            <p>
                                A note is a file with any extension, for example <code>queries.sql</code> or <code>todo.md</code>. The files are in{' '}
                                <code>{folder || '~/.shipwarden/notes'}</code>. Folders are optional, and they can be in other folders.
                            </p>
                        </div>
                    )}
                    {notes && notes.length > 0 && filtering && shown.length === 0 && <div className="panel-message">No note matches.</div>}

                    {shownRootFolders.map(folderNode)}

                    {shownRootFolders.length > 0 && (topLevel.length > 0 || dropTarget === '' || (editing?.kind === 'note' && !editing.folder)) && (
                        <div className="note-top-heading">Not in a folder</div>
                    )}
                    {editing?.kind === 'note' && editing.folder === '' && inputs('')}
                    {topLevel.map(noteRow)}
                </div>
                <ResizeHandle
                    panel={listWidth}
                    edge="right"
                    label="Resize the note list"
                    maxAvailable={() => (document.querySelector<HTMLElement>('.notes-body')?.offsetWidth ?? Infinity) - 320}
                />
                {current ? (
                    <NoteEditor
                        key={current.name}
                        note={current}
                        folder={folder}
                        folders={folders}
                        allTags={allTags.map(([tag]) => tag)}
                        onRenamed={name => {
                            select(name);
                            void load();
                        }}
                        onDeleted={() => {
                            const next = shown.find(note => note.name !== current.name);
                            select(next?.name);
                            void load();
                        }}
                        onTags={tags => void setTags(current, tags)}
                    />
                ) : (
                    <div className="note-pane panel-message">{notes?.length ? 'Select a note.' : 'Create a note with New note.'}</div>
                )}
            </div>
        </div>
    );
}
