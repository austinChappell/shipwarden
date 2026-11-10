import { useCallback, useEffect, useState, type SetStateAction } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { statusForColumn, statusKey, type StatusGroup, type StatusOrder, type Task, type TaskSource, type TaskStatus } from '@shared/tasks';
import { errorText, optionalErrorText } from '../../util';
import { promptDialog } from '../ConfirmDialog';
import { patchTask, prependTask, taskQueryKeys, uniqueTasks } from './task-view-logic';
import type { TaskRequest } from './use-task-source';

const api = window.shipwarden.tasks;
/** The list loads at most this number of pages. ClickUp sends 100 tasks per page. */
const MAX_PAGES = 5;

interface Options {
    /** The project key of the task data (see `taskProjectKey`). */
    projectKey: string;
    /** The source of the selected connection, or undefined while it loads. */
    source: TaskSource | null | undefined;
    collection: string | undefined;
    filter: string | undefined;
    request: TaskRequest;
    setSelectedId(id: string | undefined): void;
}

/**
 * The tasks of the selected collection. The query cache keeps them for the session.
 * The list loads again when its data is stale, on the timer of the query client and on change notifications.
 */
export function useTaskList({ projectKey, source, collection, filter, request, setSelectedId }: Options) {
    const queryClient = useQueryClient();
    const connectionId = source?.connectionId;
    const listKey = taskQueryKeys.list(connectionId, projectKey, collection, filter);
    /** The error of the last action on the list, for example a failed move. */
    const [actionError, setActionError] = useState<string>();
    /** The tasks that move to another status now. */
    const [moving, setMoving] = useState<Set<string>>(new Set());

    const listQuery = useQuery({
        queryKey: listKey,
        queryFn: async () => {
            const all: Task[] = [];
            let cursor: string | undefined;
            for (let page = 0; page < MAX_PAGES; page++) {
                const result = await request<{ tasks: Task[]; nextCursor?: string }>('tasks/list', { collection, filter, cursor });
                all.push(...result.tasks);
                cursor = result.nextCursor;
                if (!cursor) {
                    break;
                }
            }
            return uniqueTasks(all);
        },
        enabled: !!source && !!collection
    });
    const tasks = source && collection ? listQuery.data : undefined;

    /** The workflow order of the statuses from the plugin's status order adapter, if it has one. */
    const statusOrderQuery = useQuery({
        queryKey: taskQueryKeys.statusOrder(connectionId, projectKey, collection),
        queryFn: () => request<StatusOrder>('tasks/statusOrder', { collection }),
        enabled: !!source?.capabilities.statusOrder && !!collection
    });
    const statusOrder = source?.capabilities.statusOrder && collection && !statusOrderQuery.isError ? statusOrderQuery.data : undefined;

    // A new collection or filter has no error of the old one.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The body does not read the dependencies, but a change must clear the error.
    useEffect(() => setActionError(undefined), [connectionId, projectKey, collection, filter]);

    /** Changes the cached tasks of the selected collection. */
    const setTasks = (update: SetStateAction<Task[] | undefined>) =>
        queryClient.setQueryData<Task[]>(listKey, update as (list: Task[] | undefined) => Task[] | undefined);

    /** Loads the list again now. */
    const loadTasks = useCallback(async () => {
        setActionError(undefined);
        await queryClient.invalidateQueries({ queryKey: taskQueryKeys.list(connectionId, projectKey, collection, filter) });
    }, [queryClient, connectionId, projectKey, collection, filter]);

    // A change notification of the plugin marks all lists of the connection as stale. The list that shows now loads again.
    useEffect(
        () =>
            api.onChanged((changedConnection, changedProjectKey) => {
                if (changedConnection === connectionId && changedProjectKey === projectKey) {
                    void queryClient.invalidateQueries({ queryKey: ['tasks', 'list', connectionId, projectKey] });
                }
            }),
        [queryClient, connectionId, projectKey]
    );

    /** Asks for a title and makes a task in the selected collection. Then it opens the task, so the user can add a description. */
    const createTask = async () => {
        if (!collection) return;
        const title = await promptDialog({ title: 'New task', placeholder: 'Title', confirmLabel: 'Create' });
        if (!title) return;
        setActionError(undefined);
        try {
            const created = await request<Task>('tasks/create', { collection, title });
            setTasks(list => prependTask(list, created));
            setSelectedId(created.id);
        } catch (err) {
            setActionError(errorText(err));
        }
    };

    /**
     * Moves a task to the status of a board column. The status comes from the task's own workflow,
     * because each ClickUp list can have its own statuses. `onUpdated` receives the updated task.
     */
    const moveTask = async (task: Task, column: StatusGroup, onUpdated: (updated: Task) => void) => {
        if (statusKey(task.status.name) === column.key || moving.has(task.id)) {
            return;
        }
        const setStatus = (status: TaskStatus) => setTasks(list => patchTask(list, task.id, { status }));
        setMoving(set => new Set(set).add(task.id));
        setActionError(undefined);
        // A list that loads now must not put the card back in its old column.
        await queryClient.cancelQueries({ queryKey: listKey });
        // Move the card at once. The request can take a second. A failure moves the card back.
        setStatus({ id: column.key, name: column.name, color: column.color, category: column.category });
        try {
            const target = statusForColumn(column.key, await request<TaskStatus[]>('tasks/statuses', { id: task.id }));
            if (!target) {
                throw new Error(`"${task.title}" cannot move to "${column.name}". Its list has no status with that name.`);
            }
            const updated = await request<Task>('tasks/update', { id: task.id, status: target.id });
            setStatus(updated.status);
            onUpdated(updated);
        } catch (err) {
            setStatus(task.status);
            setActionError(errorText(err));
        } finally {
            setMoving(set => {
                const next = new Set(set);
                next.delete(task.id);
                return next;
            });
        }
    };

    /** The error of a failed action, else the error of the last load. */
    const listError = actionError ?? (source && collection ? optionalErrorText(listQuery.error) : undefined);

    return { tasks, setTasks, loading: listQuery.isFetching, listError, statusOrder, moving, loadTasks, createTask, moveTask };
}
