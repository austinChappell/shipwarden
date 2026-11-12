import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, Command } from 'lucide-react';
import { keyParts } from '@shared/shortcuts';
import { useModal } from '../components/use-modal';
import { errorText } from '../util';
import { nextIndex, paletteSections, type PaletteItem, type PalettePage } from './palette-model';

interface Props {
    /** The items of the first page. They come from the state of the app, so they are new at each render. */
    items: PaletteItem[];
    onClose(): void;
    onError(message: string): void;
}

/** The items of a page and the state of their load. */
interface Loaded {
    items: PaletteItem[];
    loading: boolean;
    error?: string;
}

/** Loads the items of a page. A page with a list shows it at once. A page with a promise shows a loading row first. */
function usePageItems(page: PalettePage | undefined, rootItems: PaletteItem[]): Loaded {
    const [loaded, setLoaded] = useState<Loaded>({ items: [], loading: false });
    useEffect(() => {
        if (!page || Array.isArray(page.items)) return;
        let live = true;
        setLoaded({ items: [], loading: true });
        page.items.then(
            items => live && setLoaded({ items, loading: false }),
            err => live && setLoaded({ items: [], loading: false, error: errorText(err) })
        );
        return () => {
            live = false;
        };
    }, [page]);
    if (!page) return { items: rootItems, loading: false };
    if (Array.isArray(page.items)) return { items: page.items, loading: false };
    return loaded;
}

/** A key combination as key caps, for example ⇧ ⌘ P. */
function Keys({ keys }: { keys: string }) {
    return (
        <span className="palette-keys">
            <span className="visually-hidden">{keys}</span>
            <span className="palette-caps" aria-hidden="true">
                {keyParts(keys).map((part, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: The parts of one key combination never change order.
                    <kbd key={index}>{part}</kbd>
                ))}
            </span>
        </span>
    );
}

/**
 * The command palette (⇧⌘P). The user types to find a command, a worktree, a note, a plan or a pull request, and
 * presses Return. An item with more choices opens a page, for example the worktrees to remove. Escape goes back one
 * page, and on the first page it closes the palette.
 */
export function CommandPalette({ items, onClose, onError }: Props) {
    const dialog = useRef<HTMLDivElement>(null);
    useModal(dialog);
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const listId = useId();
    /** The open pages. The first page is not in the stack. */
    const [stack, setStack] = useState<PalettePage[]>([]);
    const page = stack.at(-1);
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState(0);
    const loaded = usePageItems(page, items);
    const sections = useMemo(() => paletteSections(loaded.items, query, !page), [loaded.items, query, page]);
    const rows = sections.flatMap(section => section.items);
    const active = rows[Math.min(selected, rows.length - 1)];
    const optionId = (index: number) => `${listId}-option-${index}`;

    // A new search text or a new page selects the first row.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The selection starts again only when the text or the page changes.
    useEffect(() => setSelected(0), [query, page]);
    // The selected row stays in view when the arrow keys move it.
    // biome-ignore lint/correctness/useExhaustiveDependencies: A new selection or a new list must scroll. The effect reads the DOM.
    useEffect(() => {
        list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }, [selected, rows.length]);

    const openPage = (next: PalettePage) => {
        setStack(current => [...current, next]);
        setQuery('');
        input.current?.focus();
    };
    const back = () => {
        setStack(current => current.slice(0, -1));
        setQuery('');
        input.current?.focus();
    };
    const choose = (item: PaletteItem | undefined) => {
        if (!item) return;
        if (item.page) {
            openPage(item.page());
            return;
        }
        onClose();
        // The action starts after the palette closes. Thus a dialog of the action gets the focus, and a close of that
        // dialog does not give the focus back to the palette.
        setTimeout(() => {
            Promise.resolve()
                .then(() => item.run?.())
                .catch(err => onError(errorText(err)));
        }, 0);
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (page) back();
            else onClose();
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            choose(active);
            return;
        }
        if (event.key === 'Backspace' && !query && page) {
            event.preventDefault();
            back();
            return;
        }
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        const next = nextIndex(event.key, Math.min(selected, rows.length - 1), rows.length);
        if (next !== undefined) {
            event.preventDefault();
            setSelected(next);
        }
    };

    const emptyText = page ? page.empty : 'No commands match.';
    let rowIndex = 0;

    return (
        <div className="modal-backdrop palette-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
            <div ref={dialog} className="modal command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
                <div className="palette-search">
                    {page ? (
                        <button type="button" className="palette-page" title="Go back (Escape)" onClick={back}>
                            {page.title}
                        </button>
                    ) : (
                        <Command size={15} strokeWidth={1.8} className="palette-search-icon" aria-hidden="true" />
                    )}
                    <input
                        ref={input}
                        autoFocus
                        className="palette-input"
                        type="text"
                        spellCheck={false}
                        autoComplete="off"
                        role="combobox"
                        aria-expanded="true"
                        aria-controls={listId}
                        aria-activedescendant={active ? optionId(rows.indexOf(active)) : undefined}
                        aria-label={page ? page.placeholder : 'Type a command'}
                        placeholder={page ? page.placeholder : 'Type a command, or find a worktree, note, or plan'}
                        value={query}
                        onChange={event => setQuery(event.target.value)}
                    />
                </div>
                <div ref={list} id={listId} className="palette-list" role="listbox" aria-label={page?.title ?? 'Commands'}>
                    {loaded.loading && <div className="palette-note">Loading…</div>}
                    {loaded.error && <div className="palette-note error">{loaded.error}</div>}
                    {!loaded.loading && !loaded.error && rows.length === 0 && (
                        <div className="palette-note">{query.trim() && !page ? `No results for “${query.trim()}”.` : emptyText}</div>
                    )}
                    {sections.map(section => (
                        <div key={section.group ?? 'results'} role="group" aria-label={section.group}>
                            {section.group && (
                                <div className="palette-group" aria-hidden="true">
                                    {section.group}
                                </div>
                            )}
                            {section.items.map(item => {
                                const index = rowIndex++;
                                const Icon = item.icon;
                                const isActive = item === active;
                                return (
                                    <div
                                        key={`${item.group}:${item.id}`}
                                        id={optionId(index)}
                                        role="option"
                                        aria-selected={isActive}
                                        className={`palette-row${isActive ? ' active' : ''}${item.danger ? ' danger' : ''}`}
                                        onMouseMove={() => !isActive && setSelected(index)}
                                        onMouseDown={event => event.preventDefault()}
                                        onClick={() => choose(item)}
                                    >
                                        <span className="palette-icon" aria-hidden="true">
                                            {Icon && <Icon size={15} strokeWidth={1.7} />}
                                        </span>
                                        <span className="palette-label">{item.label}</span>
                                        {item.detail && <span className="palette-detail">{item.detail}</span>}
                                        <span className="palette-end">
                                            {!section.group && !page && <span className="palette-kind">{item.group}</span>}
                                            {item.current && <Check size={14} strokeWidth={2} className="palette-current" aria-label="Current" />}
                                            {item.keys && <Keys keys={item.keys} />}
                                            {item.page && <ChevronRight size={14} strokeWidth={1.8} className="palette-more" aria-hidden="true" />}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
                <footer className="palette-footer" aria-hidden="true">
                    <span>
                        <kbd>↑</kbd>
                        <kbd>↓</kbd> Select
                    </span>
                    <span>
                        <kbd>↵</kbd> {active?.page ? 'Open' : 'Run'}
                    </span>
                    <span>
                        <kbd>esc</kbd> {page ? 'Back' : 'Close'}
                    </span>
                </footer>
            </div>
        </div>
    );
}
