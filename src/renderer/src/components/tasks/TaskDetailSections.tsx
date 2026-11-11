import { useState } from 'react';
import { Check, ChevronRight, ExternalLink, FileText, Pencil, Star } from 'lucide-react';
import type {
    CustomFieldValue,
    EditableParts,
    OptionPart,
    Task,
    TaskAttachment,
    TaskChecklist,
    TaskCustomField,
    TaskDetails,
    TaskOption,
    TaskOptions,
    TaskRef,
    TaskRelation
} from '@shared/tasks';
import { openLink } from '../../links';
import { timeAgo } from '../../util';
import { checklistProgress, customFieldEmpty, dayInputValue, formatBytes, formatDay, formatDuration, labelId } from './task-view-logic';
import { DateEditor, EmptyValue, InlineText, OptionPicker } from './TaskEditors';
import { TaskCard } from './TaskBody';
import { StatusDot, TaskAssignees, TaskAvatar, TaskLabels } from './TaskParts';

/**
 * The rows of the details for the field column: the dates, the time, the creator, the watchers and the location.
 * An editable date or estimate is not here. EditableMetaRows shows its editor.
 */
export function DetailMetaRows({ details, editable }: { details: TaskDetails | undefined; editable: EditableParts }) {
    if (!details) return null;
    const row = (label: string, value: React.ReactNode) => (
        <>
            <span className="task-meta-label">{label}</span>
            <span>{value}</span>
        </>
    );
    return (
        <>
            {details.startDate && !editable.startDate && row('Start', formatDay(details.startDate))}
            {details.dueDate && !editable.dueDate && row('Due', formatDay(details.dueDate))}
            {details.timeEstimate !== undefined && !editable.timeEstimate && row('Estimate', formatDuration(details.timeEstimate))}
            {details.timeSpent !== undefined && row('Tracked', formatDuration(details.timeSpent))}
            {details.creator &&
                row(
                    'Created by',
                    <span className="task-person">
                        <TaskAvatar person={details.creator} size={18} />
                        {details.creator.name}
                    </span>
                )}
            {details.createdAt && row('Created', <span title={new Date(details.createdAt).toLocaleString()}>{timeAgo(details.createdAt)}</span>)}
            {details.watchers?.length ? row('Watchers', <TaskAssignees assignees={details.watchers} limit={6} size={20} />) : null}
            {details.location && row('Location', <span className="task-location">{details.location}</span>)}
        </>
    );
}

/** The value of a custom field. An empty field shows a dash. */
function FieldValue({ field }: { field: TaskCustomField }) {
    if (customFieldEmpty(field) && field.type !== 'rating') return <span className="task-field-empty">–</span>;
    switch (field.type) {
        case 'boolean':
            return <input type="checkbox" checked={field.value === true} readOnly disabled aria-label={field.label} />;
        case 'date':
            return <span>{formatDay(String(field.value))}</span>;
        case 'url':
            return (
                <button className="link-button task-field-link" onClick={event => openLink(String(field.value), event)}>
                    {String(field.value)}
                </button>
            );
        case 'people':
            return (
                <span className="task-people">
                    {field.people?.map(person => (
                        <span key={person.id ?? person.name} className="task-person">
                            <TaskAvatar person={person} size={18} />
                            {person.name}
                        </span>
                    ))}
                </span>
            );
        case 'labels':
            return (
                <span className="task-labels">
                    <TaskLabels labels={field.labels} />
                </span>
            );
        case 'rating': {
            const max = field.max ?? 5;
            const value = Number(field.value ?? 0);
            return (
                <span className="task-rating" role="img" aria-label={`${value} of ${max}`}>
                    {Array.from({ length: max }, (_, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: The stars have no identity. The position is the key.
                        <Star key={index} size={14} strokeWidth={1.6} className={index < value ? 'on' : ''} />
                    ))}
                </span>
            );
        }
        case 'progress': {
            const percent = Math.max(0, Math.min(100, Number(field.value)));
            return (
                <span className="task-progress">
                    <span className="task-progress-bar">
                        <span style={{ width: `${percent}%` }} />
                    </span>
                    {Math.round(percent)}%
                </span>
            );
        }
        default:
            return <span className="task-field-text">{String(field.value)}</span>;
    }
}

interface EditorProps {
    field: TaskCustomField;
    busy: boolean;
    /** True when the plugin returns options (tasks/options). */
    canLoad: boolean;
    onChange(value: CustomFieldValue): void;
    loadOptions(part: OptionPart): Promise<TaskOptions>;
}

/** Reads a number from an input. Returns null for empty text and undefined for text that is not a number. */
function readNumber(text: string): number | null | undefined {
    if (!text.trim()) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : undefined;
}

/** The editor of a custom field that can change. A field type without an editor shows its value. */
function FieldEditor({ field, busy, canLoad, onChange, loadOptions }: EditorProps) {
    const empty = customFieldEmpty(field);
    switch (field.type) {
        case 'boolean':
            return (
                <input
                    type="checkbox"
                    checked={field.value === true}
                    disabled={busy}
                    aria-label={field.label}
                    onChange={() => onChange(field.value !== true)}
                />
            );
        case 'rating': {
            const max = field.max ?? 5;
            const value = Number(field.value ?? 0);
            return (
                <span className="task-rating editable" role="group" aria-label={`${field.label}: ${value} of ${max}`}>
                    {Array.from({ length: max }, (_, index) => (
                        <button
                            // biome-ignore lint/suspicious/noArrayIndexKey: The stars have no identity. The position is the key.
                            key={index}
                            type="button"
                            disabled={busy}
                            title={index + 1 === value ? 'Clear' : `${index + 1} of ${max}`}
                            onClick={() => onChange(index + 1 === value ? null : index + 1)}
                        >
                            <Star size={14} strokeWidth={1.6} className={index < value ? 'on' : ''} />
                        </button>
                    ))}
                </span>
            );
        }
        case 'date':
            return <DateEditor label={field.label} value={dayInputValue(empty ? undefined : String(field.value))} disabled={busy} onSave={onChange} />;
        case 'labels':
        case 'people': {
            const people = field.type === 'people';
            if (!field.options && !canLoad) return <FieldValue field={field} />;
            const selected: TaskOption[] = people
                ? (field.people ?? []).filter(person => person.id).map(person => ({ ...person, id: person.id as string }))
                : (field.labels ?? []).map(label => ({ id: labelId(label), name: label.name, color: label.color }));
            const options = field.options;
            return (
                <OptionPicker
                    label={field.label}
                    people={people}
                    multiple={people || !!field.multiple}
                    selected={selected}
                    disabled={busy}
                    load={() => (options ? Promise.resolve({ options }) : loadOptions(`custom:${field.id}`))}
                    onChange={ids => onChange(ids.length ? ids : null)}
                >
                    {empty ? <EmptyValue text="–" /> : <FieldValue field={field} />}
                </OptionPicker>
            );
        }
        case 'number':
        case 'progress':
            return (
                <InlineText
                    label={field.label}
                    type="number"
                    value={empty ? '' : String(field.value)}
                    disabled={busy}
                    onSave={text => {
                        const value = readNumber(text);
                        if (value === undefined) return 'Write a number.';
                        if (field.type === 'progress' && value !== null && (value < 0 || value > 100)) return 'Write a number from 0 to 100.';
                        onChange(value);
                        return undefined;
                    }}
                >
                    {empty ? <EmptyValue text="–" /> : <FieldValue field={field} />}
                </InlineText>
            );
        case 'url':
        case 'text': {
            const editor = (
                <InlineText
                    label={field.label}
                    type={field.type === 'url' ? 'url' : 'text'}
                    value={empty ? '' : String(field.value)}
                    disabled={busy}
                    onSave={text => {
                        onChange(text.trim() || null);
                        return undefined;
                    }}
                >
                    {empty ? <EmptyValue text="–" /> : field.type === 'url' ? <Pencil size={12} strokeWidth={1.6} /> : <FieldValue field={field} />}
                </InlineText>
            );
            // A link opens on a click, so a separate button edits it.
            return field.type === 'url' && !empty ? (
                <span className="task-field-url">
                    <FieldValue field={field} />
                    {editor}
                </span>
            ) : (
                editor
            );
        }
    }
}

interface FieldsProps {
    fields: TaskCustomField[] | undefined;
    /** True when the plugin can change tasks. A field with `editable` then shows an editor. */
    canUpdate: boolean;
    canLoad: boolean;
    busy: boolean;
    onChange(id: string, value: CustomFieldValue): void;
    loadOptions(part: OptionPart): Promise<TaskOptions>;
}

/** The custom fields of the task. The empty fields stay hidden until the user shows them. */
export function CustomFieldsSection({ fields, canUpdate, canLoad, busy, onChange, loadOptions }: FieldsProps) {
    const [showEmpty, setShowEmpty] = useState(false);
    if (!fields?.length) return null;
    const empty = fields.filter(customFieldEmpty).length;
    const shown = showEmpty ? fields : fields.filter(field => !customFieldEmpty(field));
    return (
        <TaskCard
            title="Fields"
            count={fields.length}
            actions={
                empty > 0 && (
                    <button className="link-button task-fields-toggle" onClick={() => setShowEmpty(!showEmpty)}>
                        {showEmpty ? `Hide ${empty} empty` : `Show ${empty} empty`}
                    </button>
                )
            }
        >
            <div className="task-fields">
                {shown.map(field => (
                    <div key={field.id} className="task-field">
                        <span className="task-meta-label">{field.label}</span>
                        <span className="task-field-value">
                            {canUpdate && field.editable ? (
                                <FieldEditor
                                    field={field}
                                    busy={busy}
                                    canLoad={canLoad}
                                    onChange={value => onChange(field.id, value)}
                                    loadOptions={loadOptions}
                                />
                            ) : (
                                <FieldValue field={field} />
                            )}
                        </span>
                    </div>
                ))}
            </div>
        </TaskCard>
    );
}

interface RefProps {
    task: TaskRef;
    /** A loaded task with the same ID. It gives the title when the reference has none. */
    known: Task | undefined;
    onOpenTask(id: string): void;
}

/** A row for another task. A click opens the task in the dialog. The icon opens it in the tracker. */
function TaskRefRow({ task, known, onOpenTask }: RefProps) {
    const title = task.title ?? known?.title;
    const key = task.key ?? known?.key;
    const status = task.status ?? known?.status;
    const assignees = task.assignees?.length ? task.assignees : known?.assignees;
    const url = task.url ?? known?.url;
    return (
        <div className="task-ref">
            <button className="task-ref-open" title="Open this task" onClick={() => onOpenTask(task.id)}>
                {status ? <StatusDot status={status} /> : <ChevronRight size={12} strokeWidth={1.8} />}
                {key && <span className="task-key">{key}</span>}
                <span className={`task-ref-title${title ? '' : ' unknown'}`}>{title ?? `Task ${task.id}`}</span>
            </button>
            <TaskAssignees assignees={assignees} limit={3} />
            {url && (
                <button className="icon-button" title="Open in the browser" onClick={event => openLink(url, event)}>
                    <ExternalLink size={13} strokeWidth={1.6} />
                </button>
            )}
        </div>
    );
}

const RELATION_TITLES: Record<TaskRelation, string> = {
    blocked_by: 'Waiting on',
    blocks: 'Blocking',
    related: 'Related'
};

interface RelatedProps {
    details: TaskDetails | undefined;
    findTask(id: string): Task | undefined;
    onOpenTask(id: string): void;
}

/** The parent task, the subtasks and the linked tasks. */
export function RelatedTasksSection({ details, findTask, onOpenTask }: RelatedProps) {
    if (!details) return null;
    const groups: { title: string; count?: string; tasks: TaskRef[] }[] = [];
    if (details.parent) groups.push({ title: 'Parent task', tasks: [details.parent] });
    if (details.subtasks?.length) {
        const done = details.subtasks.filter(task => {
            const category = (task.status ?? findTask(task.id)?.status)?.category;
            return category === 'done' || category === 'canceled';
        }).length;
        groups.push({ title: 'Subtasks', count: `${done}/${details.subtasks.length}`, tasks: details.subtasks });
    }
    for (const relation of ['blocked_by', 'blocks', 'related'] as const) {
        const tasks = (details.links ?? []).filter(link => link.relation === relation).map(link => link.task);
        if (tasks.length) groups.push({ title: RELATION_TITLES[relation], tasks });
    }
    return groups.map(group => (
        <TaskCard key={group.title} title={group.title} count={group.count}>
            <div className="task-refs">
                {group.tasks.map(task => (
                    <TaskRefRow key={task.id} task={task} known={findTask(task.id)} onOpenTask={onOpenTask} />
                ))}
            </div>
        </TaskCard>
    ));
}

interface ChecklistProps {
    checklists: TaskChecklist[] | undefined;
    busy: boolean;
    /** Changes the done state of an item. Without it, the items are read-only. */
    onToggle?(id: string, done: boolean): void;
}

/** The checklists of the task. With `onToggle`, a click on an item with an ID changes its done state. */
export function ChecklistsSection({ checklists, busy, onToggle }: ChecklistProps) {
    if (!checklists?.length) return null;
    return checklists.map((checklist, index) => {
        const { done, total } = checklistProgress([checklist]);
        return (
            // biome-ignore lint/suspicious/noArrayIndexKey: Two checklists can have the same name. The order does not change while the dialog shows.
            <TaskCard key={index} title={checklist.name} count={`${done}/${total}`}>
                <ul className="task-checklist">
                    {checklist.items.map((item, itemIndex) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: Two items can have the same name. The order does not change while the dialog shows.
                        <li key={itemIndex} className={item.done ? 'done' : ''}>
                            {onToggle && item.id ? (
                                <button
                                    type="button"
                                    className="task-check editable"
                                    role="checkbox"
                                    aria-checked={item.done}
                                    aria-label={item.name}
                                    disabled={busy}
                                    onClick={() => onToggle(item.id as string, !item.done)}
                                >
                                    {item.done && <Check size={11} strokeWidth={2.4} />}
                                </button>
                            ) : (
                                <span className="task-check" role="img" aria-label={item.done ? 'Done' : 'Not done'}>
                                    {item.done && <Check size={11} strokeWidth={2.4} />}
                                </span>
                            )}
                            <span className="task-checklist-name">{item.name}</span>
                            {item.assignee && <TaskAvatar person={item.assignee} size={16} />}
                        </li>
                    ))}
                </ul>
            </TaskCard>
        );
    });
}

/** The attachments of the task. An image shows its thumbnail. A click opens the file in the browser. */
export function AttachmentsSection({ attachments }: { attachments: TaskAttachment[] | undefined }) {
    if (!attachments?.length) return null;
    return (
        <TaskCard title="Attachments" count={attachments.length}>
            <div className="task-attachments">
                {attachments.map(file => (
                    <button key={file.url} className="task-attachment" title={file.name} onClick={event => openLink(file.url, event)}>
                        {file.thumbnailUrl ? (
                            <img src={file.thumbnailUrl} alt="" referrerPolicy="no-referrer" loading="lazy" />
                        ) : (
                            <span className="task-attachment-icon">
                                <FileText size={22} strokeWidth={1.4} />
                            </span>
                        )}
                        <span className="task-attachment-name">{file.name}</span>
                        {file.size !== undefined && <span className="task-attachment-size">{formatBytes(file.size)}</span>}
                    </button>
                ))}
            </div>
        </TaskCard>
    );
}
