import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, LoaderCircle, Plus, Search } from 'lucide-react';
import type { TaskOption, TaskOptions } from '@shared/tasks';
import { errorText } from '../../util';
import { DatePicker } from '../ui/DatePicker';
import { Popover } from '../ui/Popover';
import { formatDay } from './task-view-logic';
import { TaskAvatar } from './TaskParts';

interface PickerProps {
    /** The name of the part, for example "Labels". The search field and the list use it. */
    label: string;
    /** The current values as options. */
    selected: TaskOption[];
    multiple: boolean;
    /** Loads the options. The picker calls it when it opens. */
    load(): Promise<TaskOptions>;
    /** The new list of option IDs. A multi-select sends it when the list closes. */
    onChange(ids: string[]): void;
    disabled?: boolean;
    /** True when the options are people. Then each option shows an avatar. */
    people?: boolean;
    /** The content of the button: the current value. */
    children: ReactNode;
}

/** True when each word of the search text is in the name. */
function matches(option: TaskOption, query: string): boolean {
    const name = option.name.toLowerCase();
    return query
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every(word => name.includes(word));
}

/**
 * A picker for a part of a task with options, for example the assignees, the labels or the priority. The options load
 * when the list opens. A multi-select keeps the changes until the list closes, and then sends one request.
 * A single select sends the change immediately. It has a "None" item that clears the value.
 */
export function OptionPicker({ label, selected, multiple, load, onChange, disabled, people, children }: PickerProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const [result, setResult] = useState<TaskOptions>();
    const [error, setError] = useState<string>();
    const [draft, setDraft] = useState<string[]>([]);
    const trigger = useRef<HTMLButtonElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const id = useId();
    const current = useMemo(() => selected.map(option => option.id), [selected]);
    // The caller can give a new function on each render. The options load only when the list opens.
    const loader = useRef(load);
    loader.current = load;

    useEffect(() => {
        if (!open) return;
        let live = true;
        setError(undefined);
        loader.current().then(
            value => live && setResult(value),
            err => live && setError(errorText(err))
        );
        return () => {
            live = false;
        };
    }, [open]);

    /** The options and the current values that the options do not have, in that order. */
    const all = useMemo(() => {
        const options = result?.options ?? [];
        const known = new Set(options.map(option => option.id));
        return [...options, ...selected.filter(option => !known.has(option.id))];
    }, [result, selected]);

    const text = query.trim();
    const canCreate = !!result?.create && !!text && !all.some(option => option.name.toLowerCase() === text.toLowerCase());
    /** The rows of the list: "None" for a single select, the matching options, and the new option. */
    const rows = useMemo(() => {
        const shown: (TaskOption & { create?: boolean; none?: boolean })[] = all.filter(option => matches(option, text));
        if (!multiple && !text) shown.unshift({ id: '', name: 'None', none: true });
        if (canCreate) shown.push({ id: text, name: text, create: true });
        return shown;
    }, [all, text, multiple, canCreate]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: The effect must run when the active row changes. It finds the row in the page.
    useEffect(() => {
        list.current?.querySelector('.combobox-option.active')?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    const show = () => {
        setQuery('');
        setActive(0);
        setDraft(current);
        setOpen(true);
    };

    /** Closes the list. A multi-select sends its changes. */
    const hide = (focus = true) => {
        setOpen(false);
        if (focus) trigger.current?.focus();
        if (multiple) {
            const changed = draft.length !== current.length || draft.some(value => !current.includes(value));
            if (changed) onChange(draft);
        }
    };

    const choose = (row: (typeof rows)[number] | undefined) => {
        if (!row) return;
        if (multiple) {
            setDraft(list => (list.includes(row.id) ? list.filter(value => value !== row.id) : [...list, row.id]));
            if (row.create) setQuery('');
            return;
        }
        setOpen(false);
        trigger.current?.focus();
        const next = row.none ? [] : [row.id];
        if (next.join() !== current.join()) onChange(next);
    };

    const isChecked = (value: string) => (multiple ? draft.includes(value) : current.includes(value) || (value === '' && current.length === 0));

    const onKey = (event: KeyboardEvent) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(index => Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))));
        } else if (event.key === 'Enter') {
            event.preventDefault();
            choose(rows[active]);
        } else if (event.key === 'Escape') {
            // Escape closes only the list. The dialog around it stays open.
            event.preventDefault();
            event.stopPropagation();
            hide();
        } else if (event.key === 'Tab') {
            event.preventDefault();
            hide();
        }
    };

    return (
        <>
            <button
                ref={trigger}
                type="button"
                className={`task-edit-button${open ? ' on' : ''}`}
                disabled={disabled}
                title={`Change the ${label.toLowerCase()}`}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => (open ? hide(false) : show())}
            >
                {children}
            </button>
            {open && (
                <Popover anchor={trigger} onClose={() => hide(false)} className="option-picker">
                    <label className="combobox-search">
                        <Search size={13} strokeWidth={1.6} />
                        <input
                            autoFocus
                            value={query}
                            placeholder={result?.create ? `Search or add ${label.toLowerCase()}` : `Search ${label.toLowerCase()}`}
                            spellCheck={false}
                            role="combobox"
                            aria-expanded="true"
                            aria-controls={`${id}-list`}
                            aria-activedescendant={rows[active] ? `${id}-row-${active}` : undefined}
                            onChange={event => {
                                setQuery(event.target.value);
                                setActive(0);
                            }}
                            onKeyDown={onKey}
                        />
                    </label>
                    <div className="combobox-list" id={`${id}-list`} ref={list} role="listbox" aria-label={label} aria-multiselectable={multiple || undefined}>
                        {!result && !error && (
                            <div className="combobox-empty">
                                <LoaderCircle size={13} className="spin" /> Loading…
                            </div>
                        )}
                        {error && <div className="combobox-empty form-error">{error}</div>}
                        {result && rows.length === 0 && <div className="combobox-empty">No matches</div>}
                        {rows.map((row, index) => (
                            <div
                                key={`${row.create ? 'new:' : ''}${row.id}`}
                                id={`${id}-row-${index}`}
                                role="option"
                                aria-selected={isChecked(row.id)}
                                className={`combobox-option option-row${index === active ? ' active' : ''}`}
                                onMouseMove={() => setActive(index)}
                                onMouseDown={event => event.preventDefault()}
                                onClick={() => choose(row)}
                            >
                                <span className="select-check">{isChecked(row.id) && !row.create && <Check size={13} strokeWidth={2} />}</span>
                                {row.create ? (
                                    <Plus size={13} strokeWidth={1.8} />
                                ) : people && !row.none ? (
                                    <TaskAvatar person={row} size={18} />
                                ) : row.color ? (
                                    <span className="option-swatch" style={{ background: row.color }} />
                                ) : null}
                                <span className={`combobox-label${row.none ? ' muted' : ''}`}>{row.create ? `Add "${row.name}"` : row.name}</span>
                            </div>
                        ))}
                    </div>
                </Popover>
            )}
        </>
    );
}

interface TextProps {
    /** The value in the input when the edit starts. */
    value: string;
    /** The content of the button when the editor is closed. */
    children: ReactNode;
    label: string;
    placeholder?: string;
    type?: 'text' | 'number' | 'url';
    disabled?: boolean;
    /** Saves the text. It returns an error text for a value that is not valid. Then the input stays open. */
    onSave(text: string): string | undefined;
}

/** A value that changes to an input on a click. Enter or a click outside saves the value. Escape cancels the edit. */
export function InlineText({ value, children, label, placeholder, type = 'text', disabled, onSave }: TextProps) {
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(value);
    const [error, setError] = useState<string>();
    const cancelled = useRef(false);

    if (!editing) {
        return (
            <button
                type="button"
                className="task-edit-button"
                disabled={disabled}
                title={`Change the ${label.toLowerCase()}`}
                onClick={() => {
                    cancelled.current = false;
                    setText(value);
                    setError(undefined);
                    setEditing(true);
                }}
            >
                {children}
            </button>
        );
    }

    /** Saves one time. After a save or a cancel, a blur of the closing input does nothing. */
    const save = () => {
        if (cancelled.current) return;
        const problem = text === value ? undefined : onSave(text);
        setError(problem);
        if (!problem) {
            cancelled.current = true;
            setEditing(false);
        }
    };

    return (
        <span className="task-inline-edit">
            <input
                className={`task-inline-input${error ? ' invalid' : ''}`}
                type={type}
                value={text}
                placeholder={placeholder}
                aria-label={label}
                aria-invalid={!!error}
                title={error}
                autoFocus
                onChange={event => {
                    setText(event.target.value);
                    setError(undefined);
                }}
                onBlur={save}
                onKeyDown={event => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        save();
                    } else if (event.key === 'Escape') {
                        // Escape closes only the input. The dialog around it stays open.
                        event.preventDefault();
                        event.stopPropagation();
                        cancelled.current = true;
                        setEditing(false);
                    }
                }}
            />
            {error && <span className="task-inline-error">{error}</span>}
        </span>
    );
}

interface DateProps {
    /** "YYYY-MM-DD", or empty for no date. */
    value: string;
    label: string;
    disabled?: boolean;
    /** The new day "YYYY-MM-DD", or null to clear the date. */
    onSave(day: string | null): void;
}

/** A day of the task details. A click opens a calendar. The calendar can also clear the date. */
export function DateEditor({ value, label, disabled, onSave }: DateProps) {
    return (
        <DatePicker value={value} label={label} disabled={disabled} onChange={onSave}>
            {value ? formatDay(value) : <EmptyValue />}
        </DatePicker>
    );
}

/** The text of an empty value in an editor. */
export function EmptyValue({ text = 'None' }: { text?: string }) {
    return <span className="task-field-empty">{text}</span>;
}
