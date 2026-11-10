import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, Search, UserX } from 'lucide-react';
import { ALL_ASSIGNEES, ME, personKey, showsAllAssignees, type AssigneeFilter, type TaskPerson } from '@shared/tasks';
import { TaskAvatar } from './TaskParts';

interface Props {
    /** The people that the filter lists. */
    people: TaskPerson[];
    /** The person key of the user of the connection, if the plugin sends it. */
    me: string | undefined;
    /** True when the plugin knows the user of the connection. Then the list starts with "Me". */
    showMe: boolean;
    value: AssigneeFilter;
    onChange(value: AssigneeFilter): void;
}

interface Row {
    /** A person key, ME, or "unassigned". */
    key: string;
    label: string;
    person?: TaskPerson;
}

const UNASSIGNED = 'unassigned';

/** The text on the button: "All assignees", or the first selected item and the number of the other items. */
export function assigneeSummary(value: AssigneeFilter, people: readonly TaskPerson[]): string {
    if (showsAllAssignees(value)) return 'All assignees';
    const names = value.people.map(key => (key === ME ? 'Me' : (people.find(person => personKey(person) === key)?.name ?? 'Unknown person')));
    if (value.unassigned) names.push('Unassigned');
    return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
}

/** The assignee filter: a list of check boxes for "Me", "Unassigned" and each person. No selection shows all tasks. */
export function AssigneeFilterPicker({ people, me, showMe, value, onChange }: Props) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const root = useRef<HTMLDivElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const id = useId();

    const mePerson = me ? people.find(person => personKey(person) === me) : undefined;
    const rows = useMemo((): Row[] => {
        const fixed: Row[] = [...(showMe ? [{ key: ME, label: 'Me', person: mePerson }] : []), { key: UNASSIGNED, label: 'Unassigned' }];
        // The "Me" row is the user, so the user's own row is not necessary.
        const others = people
            .filter(person => !(showMe && me && personKey(person) === me))
            .map(person => ({ key: personKey(person), label: person.name, person }));
        const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        return [...fixed, ...others].filter(row => words.every(word => row.label.toLowerCase().includes(word)));
    }, [people, me, mePerson, showMe, query]);

    useEffect(() => {
        if (!open) return;
        const onDown = (event: MouseEvent) => {
            if (!root.current?.contains(event.target as Node)) setOpen(false);
        };
        window.addEventListener('mousedown', onDown);
        return () => window.removeEventListener('mousedown', onDown);
    }, [open]);

    const checked = (key: string) => (key === UNASSIGNED ? value.unassigned : value.people.includes(key));

    const toggle = (key: string) => {
        if (key === UNASSIGNED) {
            onChange({ ...value, unassigned: !value.unassigned });
            return;
        }
        const people = value.people.includes(key) ? value.people.filter(item => item !== key) : [...value.people, key];
        onChange({ ...value, people });
    };

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

    const all = showsAllAssignees(value);
    return (
        <div
            className={`combobox assignee-select${all ? '' : ' active'}`}
            ref={root}
            onBlur={event => {
                if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
            }}
        >
            <button
                ref={trigger}
                type="button"
                className={`tasks-select combobox-button${open ? ' on' : ''}`}
                title="Assignees"
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => {
                    setQuery('');
                    setOpen(!open);
                }}
            >
                <span className="combobox-value">{assigneeSummary(value, people)}</span>
                <ChevronDown size={13} strokeWidth={1.8} />
            </button>
            {open && (
                <div className="combobox-popover assignee-popover" onKeyDown={onKey}>
                    <label className="combobox-search">
                        <Search size={13} strokeWidth={1.6} />
                        <input
                            autoFocus
                            value={query}
                            placeholder="Search people"
                            spellCheck={false}
                            aria-controls={`${id}-list`}
                            onChange={event => setQuery(event.target.value)}
                        />
                        {!all && (
                            <button type="button" className="link-button" onClick={() => onChange(ALL_ASSIGNEES)}>
                                Clear
                            </button>
                        )}
                    </label>
                    <div className="combobox-list" id={`${id}-list`} ref={list} role="group" aria-label="Assignees">
                        {rows.length === 0 && <div className="combobox-empty">No matches</div>}
                        {rows.map(row => (
                            <label key={row.key} className="combobox-option assignee-option">
                                <input type="checkbox" checked={checked(row.key)} onChange={() => toggle(row.key)} />
                                {row.key === UNASSIGNED ? (
                                    <span className="task-avatar initials assignee-none" aria-hidden="true">
                                        <UserX size={11} strokeWidth={1.8} />
                                    </span>
                                ) : (
                                    <TaskAvatar person={row.person ?? { name: row.label }} size={18} />
                                )}
                                <span className="combobox-label">{row.label}</span>
                            </label>
                        ))}
                    </div>
                    <div className="assignee-hint">
                        {all ? 'No selection shows the tasks of all people.' : 'A task shows when it has one of the selected people.'}
                    </div>
                </div>
            )}
        </div>
    );
}
