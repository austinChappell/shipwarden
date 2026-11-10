import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { Task, TaskComment, TaskSource, TaskStatus } from '@shared/tasks';
import { taskSeenKey } from '@shared/dashboard';
import { errorText } from '../../util';
import { cached, remember } from '../../data-cache';
import { seenStore } from '../../seen-store';
import { alertDialog, confirmDialog } from '../ConfirmDialog';
import { detailKey, patchTask, removeTask, type CachedDetail } from './task-view-logic';
import type { TaskRequest } from './use-task-source';

interface Options {
    projectId: string;
    source: TaskSource | null | undefined;
    selectedId: string | undefined;
    setSelectedId(id: string | undefined): void;
    request: TaskRequest;
    setTasks: Dispatch<SetStateAction<Task[] | undefined>>;
    loadTasks(): Promise<void>;
}

/** The title and the description in the edit form, when the user edits the task. */
export interface TaskEdit {
    title: string;
    description: string;
}

/** The details of the selected task, its statuses and comments, and the actions on the task. */
export function useTaskDetail({ projectId, source, selectedId, setSelectedId, request, setTasks, loadTasks }: Options) {
    const [detail, setDetail] = useState<Task>();
    const [statuses, setStatuses] = useState<TaskStatus[]>([]);
    const [comments, setComments] = useState<TaskComment[]>([]);
    const [commentText, setCommentText] = useState('');
    const [busy, setBusy] = useState(false);
    const [detailError, setDetailError] = useState<string>();
    const [editing, setEditing] = useState<TaskEdit>();

    const loadDetail = useCallback(
        async (id: string) => {
            setDetailError(undefined);
            try {
                const [task, statusList, commentList] = await Promise.all([
                    request<Task>('tasks/get', { id }),
                    source?.capabilities.statuses ? request<TaskStatus[]>('tasks/statuses', { id }) : Promise.resolve([]),
                    source?.capabilities.comments ? request<TaskComment[]>('comments/list', { taskId: id }) : Promise.resolve([])
                ]);
                setDetail(task);
                setStatuses(statusList);
                setComments(commentList);
                if (source) remember(detailKey(source.connectionId, projectId, id), { task, statuses: statusList, comments: commentList });
                // The comments of an open task count as seen on the Dashboard.
                if (source) {
                    seenStore.mark(commentList.map(comment => taskSeenKey(source.connectionId, comment.id)));
                }
            } catch (err) {
                setDetailError(errorText(err));
            }
        },
        [request, source, projectId]
    );

    // A task shows its cached details immediately, and loads new details in the background.
    useEffect(() => {
        const last = source && selectedId ? cached<CachedDetail>(detailKey(source.connectionId, projectId, selectedId)) : undefined;
        setDetail(last?.task);
        setComments(last?.comments ?? []);
        setStatuses(last?.statuses ?? []);
        setEditing(undefined);
        if (selectedId) {
            loadDetail(selectedId);
        }
    }, [selectedId, loadDetail]);

    /** Runs an action on the task. The detail panel shows the error of a failed action. */
    const act = async (action: () => Promise<void>) => {
        setBusy(true);
        setDetailError(undefined);
        try {
            await action();
        } catch (err) {
            setDetailError(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    const changeStatus = (statusId: string) =>
        detail &&
        act(async () => {
            const updated = await request<Task>('tasks/update', { id: detail.id, status: statusId });
            setDetail(updated);
            setTasks(list => patchTask(list, updated.id, { status: updated.status }));
        });

    const addComment = () =>
        detail &&
        commentText.trim() &&
        act(async () => {
            const created = await request<TaskComment>('comments/create', { taskId: detail.id, body: commentText.trim() });
            setComments(list => [...list, created]);
            setCommentText('');
        });

    const runAction = (actionId: string, confirmText?: string) =>
        detail &&
        act(async () => {
            if (confirmText && !(await confirmDialog({ title: confirmText }))) return;
            const result = await request<{ message?: string }>('tasks/action', { taskId: detail.id, actionId });
            if (result?.message) await alertDialog(result.message);
            await loadDetail(detail.id);
            // An action can move the task out of the filter, for example "Archive".
            await loadTasks();
        });

    const saveEdit = () =>
        detail &&
        editing &&
        act(async () => {
            const title = editing.title.trim();
            if (!title) throw new Error('A task must have a title.');
            const updated = await request<Task>('tasks/update', { id: detail.id, title, description: editing.description });
            setDetail(updated);
            setEditing(undefined);
            setTasks(list => patchTask(list, updated.id, { title: updated.title, status: updated.status, updatedAt: updated.updatedAt }));
        });

    const deleteTask = () =>
        detail &&
        act(async () => {
            if (!(await confirmDialog({ title: `Delete "${detail.title}"?`, message: 'You cannot undo this.', confirmLabel: 'Delete', danger: true }))) return;
            await request('tasks/delete', { id: detail.id });
            setTasks(list => removeTask(list, detail.id));
            setSelectedId(undefined);
        });

    /** Shows the updated task when it is the task in the details. */
    const showIfOpen = (updated: Task) => {
        if (detail?.id === updated.id) {
            setDetail(updated);
        }
    };

    return {
        detail,
        statuses,
        comments,
        commentText,
        setCommentText,
        busy,
        detailError,
        editing,
        setEditing,
        act,
        changeStatus,
        addComment,
        runAction,
        saveEdit,
        deleteTask,
        showIfOpen
    };
}
