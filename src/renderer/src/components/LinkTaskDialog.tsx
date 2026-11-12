import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link2, LoaderCircle, X } from 'lucide-react';
import { pickCollection, taskMatches, type Task, type TaskLink, type TaskSource } from '@shared/tasks';
import { errorText } from '../util';
import { Button, Combobox, IconButton, SearchInput, Select, sortedGroups } from './ui';
import { loadTaskList } from './tasks/use-task-list';
import { collectionsQueryOptions, connectionsQueryOptions } from './tasks/use-task-source';
import { pickConnection, taskQueryKeys } from './tasks/task-view-logic';
import { StatusDot } from './tasks/TaskParts';
import { useModal } from './use-modal';

const api = window.shipwarden.tasks;
/** The dialog shows at most this number of tasks. The search finds the others. */
const MAX_SHOWN = 100;
/** A cached task list that is newer than this time does not load again. The Tasks view uses the same cache. */
const LIST_STALE_MS = 5 * 60_000;

interface Props {
    /** The name of the worktree in the UI. */
    worktreeName: string;
    /** The current task of the worktree, if it has one. */
    current: TaskLink | undefined;
    /** For each task, by connection and task ID: the name of another worktree with a link to it. */
    otherWorktreeOf(connectionId: string, task: Task): string | undefined;
    onClose(): void;
    /** Links the worktree to the task. */
    onLink(task: Task, connectionId: string, pluginId: string): Promise<void>;
    /** Removes the task link of the worktree. */
    onUnlink(): Promise<void>;
}

/**
 * The dialog that links a worktree to a task. The user selects a task manager and a collection, and then a task.
 * The task lists come from the query cache of the Tasks view when they are fresh.
 */
export function LinkTaskDialog({ worktreeName, current, otherWorktreeOf, onClose, onLink, onUnlink }: Props) {
    const dialog = useRef<HTMLDivElement>(null);
    useModal(dialog);
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const list = useRef<HTMLDivElement>(null);

    const connectionsQuery = useQuery(connectionsQueryOptions());
    const connections = connectionsQuery.data?.list ?? [];
    const [chosenConnection, setChosenConnection] = useState<string>();
    const currentConnection = current ? (current.connectionId ?? current.pluginId) : undefined;
    const connectionId =
        chosenConnection ??
        (currentConnection && connections.some(item => item.id === currentConnection)
            ? currentConnection
            : connectionsQuery.data && pickConnection(connections, connectionsQuery.data.saved));
    const connection = connections.find(item => item.id === connectionId);
    const ready = !!connection?.configured;

    const sourceQuery = useQuery({
        queryKey: taskQueryKeys.source(connectionId),
        queryFn: () => api.source(connectionId as string),
        enabled: ready
    });
    const source: TaskSource | undefined = sourceQuery.data;
    const collectionsQuery = useQuery({ ...collectionsQueryOptions(connectionId), enabled: ready });
    const collections = collectionsQuery.data?.list;
    const [chosenCollection, setChosenCollection] = useState<string>();
    const collectionId =
        chosenCollection ??
        (collections && source ? pickCollection(collections, collectionsQuery.data?.saved, source.capabilities.defaultCollectionOnly) : undefined);
    const filter = source?.filters.find(item => item.default)?.id ?? source?.filters[0]?.id;

    const tasksQuery = useQuery({
        queryKey: taskQueryKeys.list(connectionId, collectionId, filter),
        queryFn: () => loadTaskList((method, params) => api.request(connectionId as string, method, params) as never, collectionId, filter),
        enabled: !!source && !!collectionId,
        staleTime: LIST_STALE_MS
    });
    const shown = useMemo(() => (tasksQuery.data ?? []).filter(task => taskMatches(task, query)).slice(0, MAX_SHOWN), [tasksQuery.data, query]);
    const collectionGroups = useMemo(
        () =>
            sortedGroups(
                collections ?? [],
                item => item.path ?? '',
                item => ({ value: item.id, label: item.name })
            ),
        [collections]
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: A new search or a new list selects the first task again.
    useEffect(() => setActive(0), [query, tasksQuery.data]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: The selected task scrolls into view each time that it changes.
    useEffect(() => {
        list.current?.querySelector('.link-task-option.active')?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    const run = async (action: () => Promise<void>) => {
        if (busy) return;
        setBusy(true);
        setError(undefined);
        try {
            await action();
            onClose();
        } catch (err) {
            setError(errorText(err));
            setBusy(false);
        }
    };
    const choose = (task: Task | undefined) => {
        if (task && connection) void run(() => onLink(task, connection.id, connection.pluginId));
    };

    const loadError = connectionsQuery.error ?? sourceQuery.error ?? collectionsQuery.error ?? tasksQuery.error;
    const loading = connectionsQuery.isPending || (ready && (sourceQuery.isPending || collectionsQuery.isPending || (!!collectionId && tasksQuery.isPending)));
    const message = loadError
        ? errorText(loadError)
        : connectionsQuery.data && connections.length === 0
          ? 'Add a task manager in Settings › Task managers first.'
          : connection && !connection.configured
            ? `Fill in the settings of ${connection.name} in Settings › Task managers first.`
            : collections && collections.length === 0
              ? 'The task manager has no lists.'
              : !loading && collectionId && shown.length === 0
                ? query
                    ? 'No task matches the search.'
                    : 'The list has no tasks.'
                : undefined;

    return (
        <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
            <div
                ref={dialog}
                className="modal new-worktree-dialog link-task-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={`Link ${worktreeName} to a task`}
                onKeyDown={event => {
                    if (event.key === 'Escape' && !busy) onClose();
                }}
            >
                <header className="modal-header">
                    <Link2 size={15} strokeWidth={1.8} />
                    <h2>Link "{worktreeName}" to a task</h2>
                    <span className="header-spacer" />
                    <IconButton icon={<X size={14} strokeWidth={1.8} />} label="Close" title="Close (Esc)" disabled={busy} onClick={onClose} />
                </header>
                <div className="modal-body">
                    {current && (
                        <p className="panel-note">
                            The worktree has the task {current.key ? `${current.key}: ` : ''}
                            {current.title}. A new task replaces it.
                        </p>
                    )}
                    <div className="link-task-sources">
                        {connections.length > 1 && (
                            <Select
                                value={connectionId}
                                aria-label="Task manager"
                                disabled={busy}
                                options={connections.map(item => ({ value: item.id, label: item.name }))}
                                onChange={value => {
                                    setChosenConnection(value);
                                    setChosenCollection(undefined);
                                }}
                            />
                        )}
                        {collections && collections.length > 1 && (
                            <Combobox
                                value={collectionId}
                                groups={collectionGroups}
                                onChange={setChosenCollection}
                                placeholder="Choose a list"
                                searchPlaceholder="Find a list"
                                disabled={busy}
                                title="The list of tasks"
                            />
                        )}
                    </div>
                    <SearchInput
                        className="link-task-search"
                        autoFocus
                        value={query}
                        placeholder="Find a task by key, title, label, or assignee"
                        aria-label="Find a task"
                        disabled={busy}
                        onChange={setQuery}
                        onKeyDown={event => {
                            if (event.key === 'ArrowDown') {
                                event.preventDefault();
                                setActive(index => Math.min(index + 1, shown.length - 1));
                            } else if (event.key === 'ArrowUp') {
                                event.preventDefault();
                                setActive(index => Math.max(index - 1, 0));
                            } else if (event.key === 'Enter') {
                                event.preventDefault();
                                choose(shown[active]);
                            }
                        }}
                    />
                    <div ref={list} className="combobox-list link-task-list" role="listbox" aria-label="Tasks">
                        {loading && (
                            <div className="combobox-empty">
                                <LoaderCircle size={12} className="spin" /> Loading the tasks…
                            </div>
                        )}
                        {message && <div className="combobox-empty">{message}</div>}
                        {shown.map((task, index) => {
                            const other = connectionId ? otherWorktreeOf(connectionId, task) : undefined;
                            const linked = current && (current.connectionId ?? current.pluginId) === connectionId && current.taskId === task.id;
                            return (
                                <div
                                    key={task.id}
                                    role="option"
                                    aria-selected={index === active}
                                    className={`combobox-option link-task-option${index === active ? ' active' : ''}`}
                                    onMouseMove={() => setActive(index)}
                                    onClick={() => choose(task)}
                                >
                                    <StatusDot status={task.status} />
                                    {task.key && <span className="task-key">{task.key}</span>}
                                    <span className="combobox-label">{task.title}</span>
                                    {linked ? (
                                        <span className="link-task-note">Linked now</span>
                                    ) : (
                                        other && (
                                            <span className="link-task-note" title={`A link moves the task from ${other} to this worktree`}>
                                                {other}
                                            </span>
                                        )
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    {error && <div className="form-error">{error}</div>}
                </div>
                <footer className="modal-footer">
                    <span className="panel-note">↑↓ select. ↩ links. Esc cancels.</span>
                    {current && (
                        <Button disabled={busy} onClick={() => void run(onUnlink)}>
                            Unlink task
                        </Button>
                    )}
                    <Button disabled={busy} onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        variant="primary"
                        icon={busy ? <LoaderCircle size={13} className="spin" /> : undefined}
                        disabled={busy || !shown[active]}
                        onClick={() => choose(shown[active])}
                    >
                        Link task
                    </Button>
                </footer>
            </div>
        </div>
    );
}
