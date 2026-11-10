import { useEffect, useState, type SetStateAction } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Task, TaskComment, TaskSource, TaskStatus } from '@shared/tasks';
import { taskSeenKey } from '@shared/dashboard';
import { errorText, optionalErrorText } from '../../util';
import { seenStore } from '../../seen-store';
import { alertDialog, confirmDialog } from '../ConfirmDialog';
import { patchTask, removeTask, taskQueryKeys, type CachedDetail } from './task-view-logic';
import type { TaskRequest } from './use-task-source';

interface Options {
    source: TaskSource | null | undefined;
    selectedId: string | undefined;
    setSelectedId(id: string | undefined): void;
    request: TaskRequest;
    setTasks(update: SetStateAction<Task[] | undefined>): void;
    loadTasks(): Promise<void>;
}

/** The title and the description in the edit form, when the user edits the task. */
export interface TaskEdit {
    title: string;
    description: string;
}

const NO_STATUSES: TaskStatus[] = [];
const NO_COMMENTS: TaskComment[] = [];

/** The details of the selected task, its statuses and comments, and the actions on the task. */
export function useTaskDetail({ source, selectedId, setSelectedId, request, setTasks, loadTasks }: Options) {
    const queryClient = useQueryClient();
    const detailKey = taskQueryKeys.detail(source?.connectionId, selectedId);
    const [commentText, setCommentText] = useState('');
    const [busy, setBusy] = useState(false);
    /** The error of the last action on the task. */
    const [actionError, setActionError] = useState<string>();
    const [editing, setEditing] = useState<TaskEdit>();

    // A task shows its cached details immediately. The details load again each time that the user selects the task.
    const detailQuery = useQuery({
        queryKey: detailKey,
        queryFn: async (): Promise<CachedDetail> => {
            const id = selectedId as string;
            const [task, statusList, commentList] = await Promise.all([
                request<Task>('tasks/get', { id }),
                source?.capabilities.statuses ? request<TaskStatus[]>('tasks/statuses', { id }) : Promise.resolve([]),
                source?.capabilities.comments ? request<TaskComment[]>('comments/list', { taskId: id }) : Promise.resolve([])
            ]);
            // The comments of an open task count as seen on the Dashboard.
            if (source) {
                seenStore.mark(commentList.map(comment => taskSeenKey(source.connectionId, comment.id)));
            }
            return { task, statuses: statusList, comments: commentList };
        },
        enabled: !!source && !!selectedId,
        staleTime: 0
    });
    const data = source && selectedId ? detailQuery.data : undefined;
    const detail = data?.task;
    const statuses = data?.statuses ?? NO_STATUSES;
    const comments = data?.comments ?? NO_COMMENTS;
    const detailError = actionError ?? (source && selectedId ? optionalErrorText(detailQuery.error) : undefined);

    /** Changes the cached details of the selected task. */
    const patchDetail = (patch: (current: CachedDetail) => CachedDetail) =>
        queryClient.setQueryData<CachedDetail>(detailKey, current => current && patch(current));
    const setDetail = (task: Task) => patchDetail(current => ({ ...current, task }));
    const loadDetail = () => queryClient.invalidateQueries({ queryKey: detailKey });

    // Another task has no edit form and no error of the old task.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The body does not read the dependencies, but a change must reset the form.
    useEffect(() => {
        setEditing(undefined);
        setActionError(undefined);
    }, [selectedId, source?.connectionId]);

    /** Runs an action on the task. The detail panel shows the error of a failed action. */
    const act = async (action: () => Promise<void>) => {
        setBusy(true);
        setActionError(undefined);
        try {
            await action();
        } catch (err) {
            setActionError(errorText(err));
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
            patchDetail(current => ({ ...current, comments: [...current.comments, created] }));
            setCommentText('');
        });

    const runAction = (actionId: string, confirmText?: string) =>
        detail &&
        act(async () => {
            if (confirmText && !(await confirmDialog({ title: confirmText }))) return;
            const result = await request<{ message?: string }>('tasks/action', { taskId: detail.id, actionId });
            if (result?.message) await alertDialog(result.message);
            await loadDetail();
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
