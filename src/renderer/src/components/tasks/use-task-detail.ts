import { useEffect, useState, type SetStateAction } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommentInput, OptionPart, Task, TaskComment, TaskOptions, TaskSource, TaskStatus, TaskUpdate } from '@shared/tasks';
import { taskSeenKey } from '@shared/dashboard';
import { errorText, optionalErrorText } from '../../util';
import { seenStore } from '../../seen-store';
import { alertDialog, confirmDialog } from '../ConfirmDialog';
import { addLabelOptions, listPatch, patchTask, removeTask, taskQueryKeys, type CachedDetail } from './task-view-logic';
import type { TaskRequest } from './use-task-source';

interface Options {
    source: TaskSource | null | undefined;
    selectedId: string | undefined;
    setSelectedId(id: string | undefined): void;
    request: TaskRequest;
    setTasks(update: SetStateAction<Task[] | undefined>): void;
    loadTasks(): Promise<void>;
}

/** The draft of the description, while the user edits it. The dialog stays open until the user saves or cancels it. */
export interface TaskEdit {
    description: string;
}

const NO_STATUSES: TaskStatus[] = [];
/** The time that the options of a part stay fresh: a few minutes. */
const OPTIONS_STALE_MS = 5 * 60 * 1000;
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

    /** Sends one change of the task to the plugin. The details and the task list show the result. No list request is necessary. */
    const updateTask = (change: Omit<TaskUpdate, 'id'>) =>
        detail &&
        act(async () => {
            const updated = await request<Task>('tasks/update', { ...change, id: detail.id });
            setDetail(updated);
            setTasks(list => patchTask(list, updated.id, listPatch(updated)));
            if (change.labels) {
                // A new label goes into the cached options, so the next list shows it without a request.
                queryClient.setQueryData<TaskOptions>(
                    taskQueryKeys.options(source?.connectionId, updated.id, 'labels'),
                    current => current && addLabelOptions(current, updated.labels ?? [])
                );
            }
        });

    const changeStatus = (statusId: string) => updateTask({ status: statusId });

    /** Loads the options of a part of the selected task. The view keeps them for a few minutes. */
    const loadOptions = (part: OptionPart) => queryClient.fetchQuery(optionsQuery(part));

    /** The query of the options of a part, for `useQuery` and `fetchQuery`. */
    const optionsQuery = (part: OptionPart) => ({
        queryKey: taskQueryKeys.options(source?.connectionId, detail?.id, part),
        queryFn: () => request<TaskOptions>('tasks/options', { id: detail?.id, part }),
        staleTime: OPTIONS_STALE_MS
    });

    /** Adds the comment in the box. `links` has the people and the tasks that the user picked with "@" and "#". */
    const addComment = (links: Pick<CommentInput, 'mentions' | 'references'> = {}) =>
        detail &&
        commentText.trim() &&
        act(async () => {
            const input: CommentInput = { taskId: detail.id, body: commentText.trim(), ...links };
            const created = await request<TaskComment>('comments/create', input);
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

    /** Saves the draft of the description. The editor closes only when the save succeeds. */
    const saveEdit = () =>
        detail &&
        editing &&
        act(async () => {
            const updated = await request<Task>('tasks/update', { id: detail.id, description: editing.description });
            setDetail(updated);
            setEditing(undefined);
            setTasks(list => patchTask(list, updated.id, listPatch(updated)));
        });

    /** Saves a new title. An empty title is not valid. */
    const saveTitle = (title: string) => {
        const value = title.trim();
        if (!value) return 'A task must have a title.';
        if (value !== detail?.title) updateTask({ title: value });
        return undefined;
    };

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
        updateTask,
        loadOptions,
        optionsQuery,
        changeStatus,
        addComment,
        runAction,
        saveEdit,
        saveTitle,
        deleteTask,
        showIfOpen
    };
}
