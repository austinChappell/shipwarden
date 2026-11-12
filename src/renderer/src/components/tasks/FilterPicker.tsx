import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { cx, inputClass } from '../ui';

export interface FilterRow {
    /** The key of the item in the filter. */
    key: string;
    label: string;
    /** The icon or the avatar in front of the label. */
    icon: ReactNode;
    checked: boolean;
}

interface Props {
    /** The class of the root element, in addition to "combobox filter-select". */
    className: string;
    /** The tooltip of the button and the accessible name of the list. */
    title: string;
    /** The text on the button. */
    summary: string;
    /** True when the filter hides tasks. Then the button has the accent color and the list has "Clear". */
    active: boolean;
    rows: FilterRow[];
    searchPlaceholder: string;
    /** The text below the list. */
    hint: string;
    onToggle(key: string): void;
    onClear(): void;
}

/** True when each word of the query is in the label. The search is not case sensitive. */
export function rowMatches(label: string, query: string): boolean {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return words.every(word => label.toLowerCase().includes(word));
}

/** A filter of the task view: a button that opens a list of check boxes with a search field. */
export function FilterPicker({ className, title, summary, active, rows, searchPlaceholder, hint, onToggle, onClear }: Props) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const root = useRef<HTMLDivElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const id = useId();
    const shown = rows.filter(row => rowMatches(row.label, query));

    useEffect(() => {
        if (!open) return;
        const onDown = (event: MouseEvent) => {
            if (!root.current?.contains(event.target as Node)) setOpen(false);
        };
        window.addEventListener('mousedown', onDown);
        return () => window.removeEventListener('mousedown', onDown);
    }, [open]);

    const hide = () => {
        setOpen(false);
        trigger.current?.focus();
    };

    /** The arrow keys move the focus between the search field and the check boxes. Escape closes the list. */
    const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            hide();
            return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const items = [
            root.current?.querySelector<HTMLElement>('.combobox-search input'),
            ...(list.current?.querySelectorAll<HTMLElement>('input') ?? [])
        ].filter((item): item is HTMLElement => !!item);
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = items[Math.min(items.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
        next?.focus();
    };

    return (
        <div
            className={`combobox filter-select ${className}${active ? ' active' : ''}`}
            ref={root}
            onBlur={event => {
                if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
            }}
        >
            <button
                ref={trigger}
                type="button"
                className={inputClass('md', { className: cx('select-button', 'combobox-button', open && 'on') })}
                title={title}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => {
                    setQuery('');
                    setOpen(!open);
                }}
            >
                <span className="select-value">{summary}</span>
                <ChevronDown size={13} strokeWidth={1.8} />
            </button>
            {open && (
                <div className="combobox-popover filter-popover" onKeyDown={onKey}>
                    <label className="combobox-search">
                        <Search size={13} strokeWidth={1.6} />
                        <input
                            autoFocus
                            value={query}
                            placeholder={searchPlaceholder}
                            spellCheck={false}
                            aria-controls={`${id}-list`}
                            onChange={event => setQuery(event.target.value)}
                        />
                        {active && (
                            <button type="button" className="link-button" onClick={onClear}>
                                Clear
                            </button>
                        )}
                    </label>
                    <div className="combobox-list" id={`${id}-list`} ref={list} role="group" aria-label={title}>
                        {shown.length === 0 && <div className="combobox-empty">No matches</div>}
                        {shown.map(row => (
                            <label key={row.key} className="combobox-option filter-option">
                                <input type="checkbox" checked={row.checked} onChange={() => onToggle(row.key)} />
                                {row.icon}
                                <span className="combobox-label">{row.label}</span>
                            </label>
                        ))}
                    </div>
                    <div className="filter-hint">{hint}</div>
                </div>
            )}
        </div>
    );
}

/** Returns the list with the key added, or without the key when the list has it. */
export function toggleKey(keys: readonly string[], key: string): string[] {
    return keys.includes(key) ? keys.filter(item => item !== key) : [...keys, key];
}
