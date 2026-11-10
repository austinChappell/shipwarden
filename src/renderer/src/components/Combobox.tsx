import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

export interface ComboboxItem {
    value: string;
    label: string;
}

export interface ComboboxGroup {
    /** The group heading. An empty label shows the items without a heading. */
    label: string;
    items: ComboboxItem[];
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Puts the items into groups by `groupOf`. The groups and the items in each group are in alphabetical order. */
export function sortedGroups<T>(items: T[], groupOf: (item: T) => string, toItem: (item: T) => ComboboxItem): ComboboxGroup[] {
    const groups = new Map<string, ComboboxItem[]>();
    for (const item of items) {
        const key = groupOf(item);
        groups.set(key, [...(groups.get(key) ?? []), toItem(item)]);
    }
    return [...groups.entries()]
        .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : collator.compare(a, b)))
        .map(([label, list]) => ({ label, items: list.sort((a, b) => collator.compare(a.label, b.label)) }));
}

interface Props {
    value: string | undefined;
    groups: ComboboxGroup[];
    onChange(value: string): void;
    /** The text on the button when no item is selected, for example while the list loads. */
    placeholder: string;
    searchPlaceholder?: string;
    disabled?: boolean;
    title?: string;
    className?: string;
    /** False removes the group label from the button text. The default is true. */
    groupPrefix?: boolean;
}

/** A select with a search field, for long lists in groups. */
export function Combobox({ value, groups, onChange, placeholder, searchPlaceholder = 'Search', disabled, title, className, groupPrefix = true }: Props) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const root = useRef<HTMLDivElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const id = useId();

    const selected = useMemo(() => {
        for (const group of groups) {
            const item = group.items.find(entry => entry.value === value);
            if (item) {
                return { group: group.label, item };
            }
        }
        return undefined;
    }, [groups, value]);

    /**
     * The items that match the search. Each word must be in the item label, or at the start of the group label.
     * "/" separates the words, so "acme/api" also matches.
     */
    const shown = useMemo(() => {
        const words = query
            .trim()
            .toLowerCase()
            .split(/[\s/]+/)
            .filter(Boolean);
        if (!words.length) {
            return groups;
        }
        return groups
            .map(group => ({
                ...group,
                items: group.items.filter(item => {
                    const label = item.label.toLowerCase();
                    const groupLabel = group.label.toLowerCase();
                    return words.every(word => label.includes(word) || groupLabel.startsWith(word));
                })
            }))
            .filter(group => group.items.length > 0);
    }, [groups, query]);
    const flat = useMemo(() => shown.flatMap(group => group.items), [shown]);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onDown = (event: MouseEvent) => {
            if (!root.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        window.addEventListener('mousedown', onDown);
        return () => window.removeEventListener('mousedown', onDown);
    }, [open]);

    // Keep the active item visible when the keys move it.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The effect must run when the active item changes or the list opens. It finds the item in the page.
    useEffect(() => {
        list.current?.querySelector('.combobox-option.active')?.scrollIntoView({ block: 'nearest' });
    }, [active, open]);

    const show = () => {
        setQuery('');
        const index = flat.findIndex(item => item.value === value);
        setActive(Math.max(0, index));
        setOpen(true);
    };

    /** Closes the popover. The focus goes back to the button. */
    const hide = () => {
        setOpen(false);
        trigger.current?.focus();
    };

    const choose = (item: ComboboxItem) => {
        hide();
        if (item.value !== value) {
            onChange(item.value);
        }
    };

    const onKey = (event: KeyboardEvent) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive(index => Math.min(flat.length - 1, index + 1));
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(index => Math.max(0, index - 1));
        } else if (event.key === 'Enter') {
            event.preventDefault();
            if (flat[active]) {
                choose(flat[active]);
            }
        } else if (event.key === 'Escape') {
            // Escape closes only the popover. A dialog around the combobox stays open.
            event.preventDefault();
            event.stopPropagation();
            hide();
        } else if (event.key === 'Tab' && event.shiftKey) {
            // Shift+Tab moves the focus to the button and closes the popover. After Tab, `onBlur` closes the popover.
            event.preventDefault();
            hide();
        }
    };

    let index = -1;
    return (
        <div
            className={`combobox${className ? ` ${className}` : ''}`}
            ref={root}
            onBlur={event => {
                // A click on an option gives no new focus. Only a focus outside the combobox closes the popover.
                if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
            }}
        >
            <button
                ref={trigger}
                type="button"
                className={`tasks-select combobox-button${open ? ' on' : ''}`}
                disabled={disabled}
                title={title}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => (open ? setOpen(false) : show())}
            >
                <span className="combobox-value">
                    {selected ? (
                        <>
                            {groupPrefix && selected.group && <span className="combobox-group-prefix">{selected.group} / </span>}
                            {selected.item.label}
                        </>
                    ) : (
                        placeholder
                    )}
                </span>
                <ChevronDown size={13} strokeWidth={1.8} />
            </button>
            {open && (
                <div className="combobox-popover">
                    <label className="combobox-search">
                        <Search size={13} strokeWidth={1.6} />
                        <input
                            autoFocus
                            value={query}
                            placeholder={searchPlaceholder}
                            spellCheck={false}
                            role="combobox"
                            aria-expanded="true"
                            aria-controls={`${id}-list`}
                            aria-activedescendant={flat[active] ? `${id}-option-${active}` : undefined}
                            onChange={event => {
                                setQuery(event.target.value);
                                setActive(0);
                            }}
                            onKeyDown={onKey}
                        />
                    </label>
                    <div className="combobox-list" role="listbox" id={`${id}-list`} ref={list}>
                        {flat.length === 0 && <div className="combobox-empty">No matches</div>}
                        {shown.map(group => (
                            <div key={group.label} role="group" aria-label={group.label || undefined}>
                                {group.label && <div className="combobox-heading">{group.label}</div>}
                                {group.items.map(item => {
                                    index += 1;
                                    const position = index;
                                    return (
                                        <div
                                            key={item.value}
                                            id={`${id}-option-${position}`}
                                            role="option"
                                            aria-selected={item.value === value}
                                            className={`combobox-option${position === active ? ' active' : ''}`}
                                            onMouseMove={() => setActive(position)}
                                            onClick={() => choose(item)}
                                        >
                                            <span className="combobox-label">{item.label}</span>
                                            {item.value === value && <Check size={13} strokeWidth={2} />}
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
