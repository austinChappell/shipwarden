import type { EditableParts, Task, TaskOption } from '@shared/tasks';
import { dayInputValue, formatDuration, labelId, parseDuration } from './task-view-logic';
import { TaskAvatar, TaskLabels } from './TaskParts';
import { DateEditor, EmptyValue, InlineText, OptionPicker } from './TaskEditors';
import type { useTaskDetail } from './use-task-detail';

interface Props {
    task: Task;
    editable: EditableParts;
    /** True when the plugin returns options (tasks/options). Without options, a picker cannot show choices. */
    canLoad: boolean;
    busy: boolean;
    state: ReturnType<typeof useTaskDetail>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <>
            <span className="task-meta-label">{label}</span>
            <span className="task-meta-value">{children}</span>
        </>
    );
}

function People({ people }: { people: Task['assignees'] }) {
    return (
        <span className="task-people">
            {people?.map(person => (
                <span key={person.id ?? person.name} className="task-person">
                    <TaskAvatar person={person} size={20} />
                    {person.name}
                </span>
            ))}
        </span>
    );
}

/**
 * The rows of the field column for the assignees, the priority, the labels, the dates and the estimate.
 * An editable part shows an editor. A part that cannot change shows its value, and only when it has one.
 */
export function EditableMetaRows({ task, editable, canLoad, busy, state }: Props) {
    const details = task.details;
    const pick = (part: 'assignees' | 'labels' | 'priority') => editable[part] && canLoad;
    const assignees: TaskOption[] = (task.assignees ?? []).filter(person => person.id).map(person => ({ ...person, id: person.id as string }));
    const labels: TaskOption[] = (task.labels ?? []).map(label => ({ id: labelId(label), name: label.name, color: label.color }));
    const priority: TaskOption[] = task.priority ? [{ id: String(task.priority.level), name: task.priority.name }] : [];

    return (
        <>
            <Row label="Assignees">
                {pick('assignees') ? (
                    <OptionPicker
                        label="Assignees"
                        people
                        multiple
                        selected={assignees}
                        disabled={busy}
                        load={() => state.loadOptions('assignees')}
                        onChange={ids => state.updateTask({ assignees: ids })}
                    >
                        {task.assignees?.length ? <People people={task.assignees} /> : <EmptyValue text="Unassigned" />}
                    </OptionPicker>
                ) : task.assignees?.length ? (
                    <People people={task.assignees} />
                ) : (
                    'Unassigned'
                )}
            </Row>
            {(pick('priority') || task.priority) && (
                <Row label="Priority">
                    {pick('priority') ? (
                        <OptionPicker
                            label="Priority"
                            multiple={false}
                            selected={priority}
                            disabled={busy}
                            load={() => state.loadOptions('priority')}
                            onChange={ids => state.updateTask({ priority: ids[0] ?? null })}
                        >
                            {task.priority ? task.priority.name : <EmptyValue />}
                        </OptionPicker>
                    ) : (
                        task.priority?.name
                    )}
                </Row>
            )}
            {(pick('labels') || !!task.labels?.length) && (
                <Row label="Labels">
                    {pick('labels') ? (
                        <OptionPicker
                            label="Labels"
                            multiple
                            selected={labels}
                            disabled={busy}
                            load={() => state.loadOptions('labels')}
                            onChange={ids => state.updateTask({ labels: ids })}
                        >
                            {task.labels?.length ? (
                                <span className="task-labels">
                                    <TaskLabels labels={task.labels} />
                                </span>
                            ) : (
                                <EmptyValue />
                            )}
                        </OptionPicker>
                    ) : (
                        <span className="task-labels">
                            <TaskLabels labels={task.labels} />
                        </span>
                    )}
                </Row>
            )}
            {editable.startDate && (
                <Row label="Start">
                    <DateEditor
                        label="Start date"
                        value={dayInputValue(details?.startDate)}
                        disabled={busy}
                        onSave={day => state.updateTask({ startDate: day })}
                    />
                </Row>
            )}
            {editable.dueDate && (
                <Row label="Due">
                    <DateEditor label="Due date" value={dayInputValue(details?.dueDate)} disabled={busy} onSave={day => state.updateTask({ dueDate: day })} />
                </Row>
            )}
            {editable.timeEstimate && (
                <Row label="Estimate">
                    <InlineText
                        label="Estimate"
                        placeholder="For example 1h 30m"
                        value={details?.timeEstimate ? formatDuration(details.timeEstimate) : ''}
                        disabled={busy}
                        onSave={text => {
                            const value = parseDuration(text);
                            if (value === undefined) return 'Write a time, for example 1h 30m, 45m or 2d.';
                            state.updateTask({ timeEstimate: value });
                            return undefined;
                        }}
                    >
                        {details?.timeEstimate ? formatDuration(details.timeEstimate) : <EmptyValue />}
                    </InlineText>
                </Row>
            )}
        </>
    );
}
