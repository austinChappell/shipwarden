import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { GitBranch, GripVertical, ListOrdered, ListTodo, RotateCcw, Trash2, X } from 'lucide-react';
import { formatAgo, pluralize } from '@shared/format';
import {
    changeQueueSettings,
    clearFinished,
    isActive,
    MAX_START_ATTEMPTS,
    moveInQueue,
    nextStarts,
    QUEUE_FINISH_LABELS,
    QUEUE_IDLE_MAX,
    QUEUE_IDLE_MIN,
    QUEUE_MAX_RUNNING_MAX,
    QUEUE_MAX_RUNNING_MIN,
    QUEUE_STATUS_LABELS,
    queuedItems,
    queueMeta,
    removeFromQueue,
    retryItem,
    type QueueFinish,
    type QueueItem,
    type QueueItemStatus,
    type QueueSettings,
    type QueueState
} from '@shared/task-queue';
import { EmptyState } from '../components/EmptyState';
import { SettingsGroup, SettingsRow, Switch } from '../components/settings-ui';
import { Button, Chip, IconButton, Input, PageHeader, Select, type ChipTone } from '../components/ui';
import { useReorder } from '../components/use-reorder';
import { useBudgetWaitFor } from '../usage-budget';
import { errorText } from '../util';
import { changeQueue, useTaskQueue } from './queue-queries';

interface Props {
    repoLabel(repo: string): string;
    onOpenWorktree(path: string, sessionId?: string): void;
    onOpenTasks(): void;
}

const STATUS_TONES: Record<QueueItemStatus, ChipTone> = {
    queued: 'neutral',
    starting: 'pending',
    running: 'pending',
    done: 'success',
    failed: 'danger'
};

/**
 * The Queue page: the tasks that ShipWarden starts one after the other, and the settings of the queue. The user drags
 * the queued tasks to change the order. The runner (`queue-runner.ts`) starts and finishes the items.
 */
export function QueueView({ repoLabel, onOpenWorktree, onOpenTasks }: Props) {
    const { state, loaded } = useTaskQueue();
    const [error, setError] = useState<string>();
    const change = (fn: (state: QueueState) => QueueState) => {
        setError(undefined);
        changeQueue(fn).catch(err => setError(errorText(err)));
    };
    const saveSettings = (settings: Partial<QueueSettings>) => change(current => changeQueueSettings(current, settings));

    const active = state.items.filter(isActive);
    const queued = queuedItems(state);
    const closed = state.items.filter(item => item.status === 'done' || item.status === 'failed').sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    const reorder = useReorder(
        queued.map(item => item.id),
        (id, to) => change(current => moveInQueue(current, id, to)),
        queued.length > 1
    );
    const empty = loaded && state.items.length === 0;
    // The next task that can start now, without the budget. When the budget stops it, the queue waits.
    const next = nextStarts(state, Date.now()).items[0];
    const budgetWait = useBudgetWaitFor(next?.agentId, next?.repoPath);
    const waiting = next ? budgetWait : undefined;

    const remove = (item: QueueItem) => change(current => removeFromQueue(current, item.id));

    return (
        <div className="queue-view">
            <PageHeader
                icon={ListOrdered}
                title="Queue"
                meta={loaded ? queueMeta(state) : undefined}
                actions={
                    closed.length > 0 ? (
                        <Button size="lg" icon={<Trash2 size={14} />} onClick={() => change(clearFinished)}>
                            Clear finished
                        </Button>
                    ) : undefined
                }
            />
            <div className="queue-scroll">
                <div className="settings-page queue-page">
                    <p className="settings-group-description queue-intro">
                        ShipWarden starts the queued tasks one after the other, while the app is open. Each task gets a new worktree from the branch template,
                        and the agent of its repository. When an agent finishes, the next task starts.
                    </p>
                    {error && <div className="form-error">{error}</div>}

                    <SettingsGroup title="Run the queue" card>
                        <SettingsRow
                            label="Queue runs"
                            description="Off stops new starts. The agents that work now continue."
                            control={
                                <Switch
                                    title={state.settings.paused ? 'Paused' : 'On'}
                                    checked={!state.settings.paused}
                                    onChange={on => saveSettings({ paused: !on })}
                                />
                            }
                        />
                        <SettingsRow
                            label="Agents at the same time"
                            description="The most agents of the queue that work at the same time."
                            control={
                                <NumberField
                                    value={state.settings.maxRunning}
                                    min={QUEUE_MAX_RUNNING_MIN}
                                    max={QUEUE_MAX_RUNNING_MAX}
                                    label="Agents at the same time"
                                    onSave={maxRunning => saveSettings({ maxRunning })}
                                />
                            }
                        />
                        <SettingsRow
                            label="An agent is finished when"
                            description="Then its place is free for the next task. An agent that exits is always finished."
                            control={
                                <Select<QueueFinish>
                                    aria-label="An agent is finished when"
                                    value={state.settings.finishWhen}
                                    options={(Object.keys(QUEUE_FINISH_LABELS) as QueueFinish[]).map(value => ({ value, label: QUEUE_FINISH_LABELS[value] }))}
                                    onChange={finishWhen => saveSettings({ finishWhen })}
                                />
                            }
                        />
                        {state.settings.finishWhen === 'idle' && (
                            <SettingsRow
                                label="Idle time"
                                description="The minutes without work, after which the agent is finished. An agent that waits for your answer is not idle."
                                control={
                                    <NumberField
                                        value={state.settings.idleMinutes}
                                        min={QUEUE_IDLE_MIN}
                                        max={QUEUE_IDLE_MAX}
                                        unit="minutes"
                                        label="Idle time in minutes"
                                        onSave={idleMinutes => saveSettings({ idleMinutes })}
                                    />
                                }
                            />
                        )}
                    </SettingsGroup>

                    {empty ? (
                        <EmptyState
                            icon={ListOrdered}
                            title="Give a backlog to ShipWarden"
                            size="compact"
                            actions={
                                <Button icon={<ListTodo size={14} />} onClick={onOpenTasks}>
                                    Open Tasks
                                </Button>
                            }
                        >
                            Select “Add to queue” on a task. The queue starts the tasks in order and keeps the limit of agents.
                        </EmptyState>
                    ) : (
                        <>
                            {active.length > 0 && (
                                <SettingsGroup title="Running" card>
                                    {active.map(item => (
                                        <QueueRow
                                            key={item.id}
                                            item={item}
                                            repoLabel={repoLabel}
                                            detail={item.startedAt ? `started ${formatAgo(new Date(item.startedAt).toISOString())}` : 'Making the worktree'}
                                        >
                                            {item.worktreePath && (
                                                <Button icon={<GitBranch size={14} />} onClick={() => onOpenWorktree(item.worktreePath ?? '', item.sessionId)}>
                                                    Open
                                                </Button>
                                            )}
                                            <IconButton
                                                size="sm"
                                                icon={<X size={14} />}
                                                label="Remove from the queue. The agent and the worktree stay, and the place is free."
                                                disabled={item.status === 'starting'}
                                                onClick={() => remove(item)}
                                            />
                                        </QueueRow>
                                    ))}
                                </SettingsGroup>
                            )}
                            {queued.length > 0 && (
                                <SettingsGroup
                                    title="Up next"
                                    description={queued.length > 1 ? 'Drag a task, or press ⌥↑ or ⌥↓, to change the order.' : undefined}
                                    card
                                >
                                    {waiting && <div className="settings-row queue-budget-wait">{waiting}</div>}
                                    {queued.map((item, index) => (
                                        <QueueRow
                                            key={item.id}
                                            item={item}
                                            repoLabel={repoLabel}
                                            position={index + 1}
                                            reorder={{
                                                props: reorder.itemProps(item.id),
                                                dropClass: reorder.dropClass(item.id),
                                                hint: reorder.hint,
                                                onKeyDown: event => reorder.moveByKey(event, item.id)
                                            }}
                                            detail={queuedDetail(item)}
                                        >
                                            <IconButton size="sm" icon={<X size={14} />} label="Remove from the queue" onClick={() => remove(item)} />
                                        </QueueRow>
                                    ))}
                                </SettingsGroup>
                            )}
                            {closed.length > 0 && (
                                <SettingsGroup title="Finished" card>
                                    {closed.map(item => (
                                        <QueueRow key={item.id} item={item} repoLabel={repoLabel} detail={closedDetail(item)}>
                                            {item.status === 'failed' && (
                                                <Button
                                                    icon={<RotateCcw size={14} />}
                                                    onClick={() => change(current => retryItem(current, item.id, Date.now()))}
                                                >
                                                    Try again
                                                </Button>
                                            )}
                                            {item.status === 'done' && item.worktreePath && (
                                                <Button icon={<GitBranch size={14} />} onClick={() => onOpenWorktree(item.worktreePath ?? '')}>
                                                    Open
                                                </Button>
                                            )}
                                            <IconButton size="sm" icon={<X size={14} />} label="Remove from the list" onClick={() => remove(item)} />
                                        </QueueRow>
                                    ))}
                                </SettingsGroup>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

/** The second line of a queued item: who added it, and the error of the last failed start. */
function queuedDetail(item: QueueItem): string {
    const added = `added ${formatAgo(new Date(item.addedAt).toISOString())}${item.addedBy ? ` by “${item.addedBy}”` : ''}`;
    if (!item.error) return added;
    return `${added} · Start ${item.attempts} of ${MAX_START_ATTEMPTS} failed: ${item.error}`;
}

/** The second line of a finished or failed item. */
function closedDetail(item: QueueItem): string {
    const when = item.finishedAt ? ` · ${formatAgo(new Date(item.finishedAt).toISOString())}` : '';
    if (item.status === 'failed') return `${pluralize(item.attempts, 'failed start')}: ${item.error ?? 'No error text.'}${when}`;
    return `${item.finishReason ?? 'The agent finished.'}${when}`;
}

interface RowReorder {
    props: object;
    dropClass: string;
    hint: string | undefined;
    onKeyDown(event: KeyboardEvent<HTMLElement>): boolean;
}

interface RowProps {
    item: QueueItem;
    repoLabel(repo: string): string;
    detail: string;
    /** The place in the queue, from 1. Only queued items have it. */
    position?: number;
    reorder?: RowReorder;
    children?: ReactNode;
}

/** One item: the status, the task, the repository and the branch, and the buttons at the right. */
function QueueRow({ item, repoLabel, detail, position, reorder, children }: RowProps) {
    const heading = item.task.key ? `${item.task.key}: ${item.task.title}` : item.task.title;
    const where = [repoLabel(item.repoPath), item.branch].filter(Boolean).join(' · ');
    return (
        <div
            className={`settings-row queue-row${reorder?.dropClass ?? ''}`}
            title={reorder?.hint}
            tabIndex={reorder?.hint ? 0 : undefined}
            onKeyDown={reorder?.onKeyDown}
            {...(reorder?.props ?? {})}
        >
            <div className="settings-row-main">
                {reorder?.hint && <GripVertical className="drag-grip" size={12} strokeWidth={1.75} aria-hidden="true" />}
                <div className="settings-row-text">
                    <div className="settings-row-label">
                        {position !== undefined ? (
                            <Chip mono>{position}</Chip>
                        ) : (
                            <Chip tone={STATUS_TONES[item.status]}>{QUEUE_STATUS_LABELS[item.status]}</Chip>
                        )}{' '}
                        {heading}
                    </div>
                    <div className="settings-row-description">
                        {where} · {detail}
                    </div>
                </div>
                <div className="settings-row-control queue-row-actions">{children}</div>
            </div>
        </div>
    );
}

/** A short number field. The value saves when the field loses the focus or on Enter. */
function NumberField({
    value,
    min,
    max,
    unit,
    label,
    onSave
}: {
    value: number;
    min: number;
    max: number;
    unit?: string;
    label: string;
    onSave(value: number): void;
}) {
    const [text, setText] = useState(String(value));
    useEffect(() => setText(String(value)), [value]);
    const commit = () => {
        const parsed = Number(text);
        const next = Number.isFinite(parsed) && text.trim() !== '' ? Math.min(max, Math.max(min, Math.round(parsed))) : value;
        setText(String(next));
        if (next !== value) onSave(next);
    };
    return (
        <span className="automation-limit">
            <Input
                type="number"
                className="automation-limit-input"
                min={min}
                max={max}
                value={text}
                aria-label={label}
                onChange={event => setText(event.target.value)}
                onBlur={commit}
                onKeyDown={event => {
                    if (event.key === 'Enter') commit();
                }}
            />
            {unit && <span className="automation-limit-unit">{unit}</span>}
        </span>
    );
}
