import { UserX } from 'lucide-react';
import { ALL_ASSIGNEES, ME, personKey, showsAllAssignees, type AssigneeFilter, type TaskPerson } from '@shared/tasks';
import { FilterPicker, toggleKey, type FilterRow } from './FilterPicker';
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
    const mePerson = me ? people.find(person => personKey(person) === me) : undefined;
    const avatar = (person: TaskPerson) => <TaskAvatar person={person} size={18} />;
    const rows: FilterRow[] = [
        ...(showMe ? [{ key: ME, label: 'Me', icon: avatar(mePerson ?? { name: 'Me' }), checked: value.people.includes(ME) }] : []),
        {
            key: UNASSIGNED,
            label: 'Unassigned',
            icon: (
                <span className="task-avatar initials assignee-none" aria-hidden="true">
                    <UserX size={11} strokeWidth={1.8} />
                </span>
            ),
            checked: value.unassigned
        },
        // The "Me" row is the user, so the user's own row is not necessary.
        ...people
            .filter(person => !(showMe && me && personKey(person) === me))
            .map(person => ({ key: personKey(person), label: person.name, icon: avatar(person), checked: value.people.includes(personKey(person)) }))
    ];

    const all = showsAllAssignees(value);
    return (
        <FilterPicker
            className="assignee-select"
            title="Assignees"
            summary={assigneeSummary(value, people)}
            active={!all}
            rows={rows}
            searchPlaceholder="Search people"
            hint={all ? 'No selection shows the tasks of all people.' : 'A task shows when it has one of the selected people.'}
            onToggle={key => onChange(key === UNASSIGNED ? { ...value, unassigned: !value.unassigned } : { ...value, people: toggleKey(value.people, key) })}
            onClear={() => onChange(ALL_ASSIGNEES)}
        />
    );
}
