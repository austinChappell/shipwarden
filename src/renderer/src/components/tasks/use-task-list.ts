import { useCallback, useEffect, useState } from 'react';
import { statusForColumn, statusKey, type StatusGroup, type StatusOrder, type Task, type TaskSource, type TaskStatus } from '@shared/tasks';
import { errorText } from '../../util';
import { cached, remember } from '../../data-cache';
import { promptDialog } from '../ConfirmDialog';
import { patchTask, prependTask, statusOrderKey, tasksKey, uniqueTasks, type ConnectionState } from './task-view-logic';
import type { TaskRequest } from './use-task-source';

const api = window.shipwarden.tasks;
const POLL_MS = 60_000;
/** The list loads at most this number of pages. ClickUp sends 100 tasks per page. */
const MAX_PAGES = 5;

interface Options {
    projectId: string;
    connectionId: string | undefined;
    connectionState: ConnectionState;
    source: TaskSource | null | undefined;
    collection: string | undefined;
    filter: string | undefined;
    request: TaskRequest;
    setListError(error: string | undefined): void;
    setSelectedId(id: string | undefined): void;
}

/** The tasks of the selected collection. The hook loads them now, on a timer and on change notifications. */
export function useTaskList({ projectId, connectionId, connectionState, source, collection, filter, request, setListError, setSelectedId }: Options) {
    const [tasks, setTasks] = useState<Task[]>();
    const [loading, setLoading] = useState(false);
    /** The workflow order of the statuses from the plugin's status order adapter, if it has one. */
    const [statusOrder, setStatusOrder] = useState<StatusOrder>();
    /** The tasks that move to another status now. */
    const [moving, setMoving] = useState<Set<string>>(new Set());

    // A task manager that is not ready has no tasks.
    useEffect(() => {
        if (connectionState !== 'ready' || !connectionId) {
            setTasks(undefined);
        }
    }, [connectionState, connectionId, projectId]);

    // A new collection or filter shows its cached tasks, or nothing. Tasks of the old collection must not show.
    useEffect(() => {
        setTasks(connectionId && collection ? cached(tasksKey(connectionId, projectId, collection, filter)) : undefined);
        setStatusOrder(connectionId && collection ? cached(statusOrderKey(connectionId, projectId, collection)) : undefined);
        setListError(undefined);
    }, [connectionId, projectId, collection, filter]);

    const loadTasks = useCallback(async () => {
        // After a switch, the old source is still in state for one render. Load only for the selected connection.
        if (!source || !collection || source.connectionId !== connectionId) return;
        setLoading(true);
        try {
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
            setTasks(remember(tasksKey(connectionId, projectId, collection, filter), uniqueTasks(all)));
            if (source.capabilities.statusOrder) {
                request<StatusOrder>('tasks/statusOrder', { collection }).then(
                    result => setStatusOrder(remember(statusOrderKey(connectionId, projectId, collection), result)),
                    () => setStatusOrder(undefined)
                );
            }
            setListError(undefined);
        } catch (err) {
            setListError(errorText(err));
        } finally {
            setLoading(false);
        }
    }, [source, collection, connectionId, projectId, filter, request]);

    // Load the list now, and again on a timer and on change notifications. The search filters the loaded tasks in the renderer.
    useEffect(() => {
        loadTasks();
    }, [loadTasks]);
    useEffect(() => {
        const timer = setInterval(loadTasks, POLL_MS);
        const off = api.onChanged((changedConnection, changedProject) => changedConnection === connectionId && changedProject === projectId && loadTasks());
        return () => {
            clearInterval(timer);
            off();
        };
    }, [loadTasks, connectionId, projectId]);

    /** Asks for a title and makes a task in the selected collection. Then it opens the task, so the user can add a description. */
    const createTask = async () => {
        if (!collection) return;
        const title = await promptDialog({ title: 'New task', placeholder: 'Title', confirmLabel: 'Create' });
        if (!title) return;
        setListError(undefined);
        try {
            const created = await request<Task>('tasks/create', { collection, title });
            setTasks(list => prependTask(list, created));
            setSelectedId(created.id);
        } catch (err) {
            setListError(errorText(err));
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
        setListError(undefined);
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
            setListError(errorText(err));
        } finally {
            setMoving(set => {
                const next = new Set(set);
                next.delete(task.id);
                return next;
            });
        }
    };

    return { tasks, setTasks, loading, statusOrder, moving, loadTasks, createTask, moveTask };
}
