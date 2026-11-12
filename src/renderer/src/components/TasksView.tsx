import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, FolderSearch, ListTodo, SearchX, Settings } from 'lucide-react';
import { EmptyState } from './EmptyState';
import type { ViewRoute } from '@shared/nav-history';
import {
    assigneeOptions,
    boardColumns,
    groupTasksByStatus,
    labelOptions,
    taskHasAssignee,
    taskHasLabel,
    taskMatches,
    type StatusGroup,
    type Task,
    type TaskLink
} from '@shared/tasks';
import { moveListFocus } from '../keyboard/list-nav';
import { missingSettingsText, noMatchText, taskLabel, taskListState, worktreeForTask } from './tasks/task-view-logic';
import { useTaskSource } from './tasks/use-task-source';
import { useTaskList } from './tasks/use-task-list';
import { useTaskDetail } from './tasks/use-task-detail';
import { useTaskViewPrefs } from './tasks/use-task-view-prefs';
import { useAssigneeFilter } from './tasks/use-assignee-filter';
import { useLabelFilter } from './tasks/use-label-filter';
import { TasksHeader } from './tasks/TasksHeader';
import { TaskStatusGroups } from './tasks/TaskList';
import { TaskBoardColumns } from './tasks/TaskBoard';
import { TaskDetails } from './tasks/TaskDetails';
import { TaskDialog } from './tasks/TaskDialog';
import { InlineTip } from './Tips';
import { Button, SkeletonRows } from './ui';

/** An empty task list. A constant keeps the props of the details the same between renders. */
const NO_TASKS: Task[] = [];

interface Props {
    /** The ShipWarden project. The view uses it only for the repository of "Start in worktree". */
    projectId: string;
    /** The repositories of the project. "Start in worktree" makes the worktree in one of them. */
    repos: string[];
    /** The task of each worktree, by worktree path. */
    links: Record<string, TaskLink>;
    onStartTask(task: Task, connectionId: string, pluginId: string, repo: string): Promise<void>;
    /** Shows a menu of the worktrees under `anchor`, and links the chosen worktree to the task. */
    onLinkWorktree(task: Task, connectionId: string, pluginId: string, anchor: Element): Promise<void>;
    /** Removes the task link of a worktree. */
    onUnlinkWorktree(worktreePath: string): Promise<void>;
    onOpenWorktree(path: string): void;
    /** The name of a repository: its name from the repository settings, else its folder name. */
    repoLabel(repo: string): string;
    /** Opens Settings, where the user configures the task managers. */
    onOpenSettings(): void;
    /** A task to open, for example from the task link of a worktree. A new `nonce` opens it again. */
    openTask?: { connectionId: string; taskId: string; nonce: number };
    /** The selected task in the query: `task`, and the task manager of the task in `connection`. */
    route: ViewRoute;
    /** Changes the selected task. The change replaces the current history entry. */
    onRoute(route: ViewRoute): void;
    /** True when the view opens for a new task, for example from the command palette. The New task dialog opens when the collection is ready. */
    createOnOpen?: boolean;
}

/** The tasks of the project's task managers, one collection at a time, with a dialog for the details of the selected task. */
export function TasksView({
    projectId,
    repos,
    links,
    onStartTask,
    onLinkWorktree,
    onUnlinkWorktree,
    onOpenWorktree,
    onOpenSettings,
    repoLabel,
    openTask,
    route,
    onRoute,
    createOnOpen
}: Props) {
    const selectedId = route.query?.task;
    const [query, setQuery] = useState('');
    /** The task manager of the selected task. The setter reads it, so it is set before the hooks below. */
    const connectionRef = useRef<string | undefined>(undefined);
    const setSelectedId = (id: string | undefined) => onRoute({ query: id ? { task: id, connection: connectionRef.current } : {} });

    const sourceState = useTaskSource(setSelectedId);
    const { connections, connectionId, source, sourceError, collection, request } = sourceState;
    /** What the task list shows before the tasks: the collections load, the user must select one, or there are none. */
    const listState = taskListState(sourceState.collections, collection);
    connectionRef.current = connectionId;
    /** The task of the history entry when the view opens. It opens as an open request, because its task manager can be a different one. */
    const [restore] = useState(() => {
        const task = route.query?.task;
        const connection = route.query?.connection;
        return task && connection ? { connectionId: connection, taskId: task, nonce: -1 } : undefined;
    });
    const openRequest = openTask ?? restore;
    const prefs = useTaskViewPrefs(projectId, source?.pluginId);
    const assigneeFilter = useAssigneeFilter({ source, collection, request });
    const assignee = assigneeFilter.filter;
    const labelFilter = useLabelFilter(connectionId);
    const label = labelFilter.filter;
    const list = useTaskList({ source, collection, filter: sourceState.filter, request, setSelectedId });
    const { tasks, loadTasks } = list;
    /** True until the New task dialog of `createOnOpen` opens. */
    const createPending = useRef(!!createOnOpen);
    // biome-ignore lint/correctness/useExhaustiveDependencies: The dialog opens one time, when the collection is ready.
    useEffect(() => {
        if (!createPending.current || !collection || !source) return;
        createPending.current = false;
        void list.createTask();
    }, [collection, source]);
    const listError = sourceState.collectionsError ?? list.listError;
    const detailState = useTaskDetail({ source, selectedId, setSelectedId, request, setTasks: list.setTasks, loadTasks });

    /**
     * An open request: select its task manager, then the task when the plugin of that task manager is ready.
     * The task shows in the details also when it is not in the selected collection.
     */
    const pendingOpen = useRef<{ connectionId: string; taskId: string } | undefined>(undefined);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Only a new nonce opens a task. A change of connection must not open the same task again.
    useEffect(() => {
        if (!openRequest) return;
        if (openRequest.connectionId === connectionId && source?.connectionId === connectionId) {
            setSelectedId(openRequest.taskId);
            return;
        }
        pendingOpen.current = { connectionId: openRequest.connectionId, taskId: openRequest.taskId };
        if (openRequest.connectionId !== connectionId) {
            sourceState.selectConnection(openRequest.connectionId);
        }
    }, [openRequest?.nonce]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Only a new source opens the waiting task. setSelectedId is new on each render, but each copy sets the same route.
    useEffect(() => {
        const pending = pendingOpen.current;
        if (pending && source && source.connectionId === pending.connectionId) {
            pendingOpen.current = undefined;
            setSelectedId(pending.taskId);
        }
    }, [source]);

    /** The detail panel. A task that the user selects with the keyboard moves the focus into it. */
    const detailRef = useRef<HTMLDivElement>(null);
    const focusDetail = useRef(false);
    /** The task of the board card that gets the focus again after a move with the keyboard. */
    const focusCard = useRef<string | undefined>(undefined);
    const selectFromKeyboard = (id: string) => {
        if (id === selectedId) {
            detailRef.current?.focus();
            return;
        }
        focusDetail.current = true;
        setSelectedId(id);
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: The focus moves after a new task shows. The body does not read selectedId, but a change must run it.
    useEffect(() => {
        if (!focusDetail.current) return;
        focusDetail.current = false;
        detailRef.current?.focus();
    }, [selectedId]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: The card gets the focus after the list updates. The body does not read tasks, but a change must run it.
    useEffect(() => {
        const id = focusCard.current;
        if (!id) return;
        focusCard.current = undefined;
        document.querySelector<HTMLElement>(`.board-card[data-task-id="${CSS.escape(id)}"]`)?.focus();
    }, [tasks]);

    const worktreeFor = (task: Task) => worktreeForTask(links, source?.connectionId, task);

    const people = useMemo(() => assigneeOptions(tasks ?? [], assigneeFilter.people), [tasks, assigneeFilter.people]);
    const labels = useMemo(() => labelOptions(tasks ?? []), [tasks]);
    // The view selects the tasks of the assignees and the labels itself. A change of a filter sends no request.
    const me = assigneeFilter.me;
    const shown = useMemo(
        () => (tasks ?? []).filter(task => taskHasAssignee(task, assignee, me) && taskHasLabel(task, label) && taskMatches(task, query)),
        [tasks, assignee, me, label, query]
    );
    /** The loaded tasks, or undefined while the tasks or the user of the "Me" filter load. */
    const listed = assigneeFilter.waitingForMe ? undefined : tasks;
    const statusGroups = useMemo(() => groupTasksByStatus(shown, list.statusOrder?.statuses), [shown, list.statusOrder]);
    /** The board has a column for each status of the collection's workflow, also without tasks, so a card can move to it. */
    const columns = useMemo(() => boardColumns(shown, list.statusOrder?.statuses), [shown, list.statusOrder]);
    const canMove = !!source?.capabilities.update && !!source?.capabilities.statuses;
    const currentConnection = connections?.find(item => item.id === connectionId);

    /** Moves a task to a board column. After a move with the keyboard, the card gets the focus again. */
    const moveTask = (task: Task, column: StatusGroup, fromKeyboard: boolean) => {
        if (fromKeyboard) {
            focusCard.current = task.id;
        }
        void list.moveTask(task, column, detailState.showIfOpen);
    };

    const detailContent = source && (
        <TaskDetails
            source={source}
            selectedId={selectedId}
            state={detailState}
            worktreeFor={worktreeFor}
            repos={repos}
            startRepo={prefs.startRepo}
            chooseStartRepo={prefs.chooseStartRepo}
            repoLabel={repoLabel}
            onOpenWorktree={onOpenWorktree}
            onStartTask={onStartTask}
            onLinkWorktree={onLinkWorktree}
            onUnlinkWorktree={onUnlinkWorktree}
            findTask={id => tasks?.find(task => task.id === id)}
            tasks={tasks ?? NO_TASKS}
            onOpenTask={setSelectedId}
        />
    );

    const itemProps = {
        selectedId,
        isCollapsed: prefs.isCollapsed,
        toggleGroup: prefs.toggleGroup,
        worktreeFor,
        onSelect: setSelectedId,
        onSelectFromKeyboard: selectFromKeyboard,
        onOpenWorktree
    };

    return (
        <div className="tasks-view">
            <TasksHeader
                connections={connections}
                connectionId={connectionId}
                selectConnection={sourceState.selectConnection}
                currentConnection={currentConnection}
                source={source}
                collections={sourceState.collections}
                collection={collection}
                selectCollection={sourceState.selectCollection}
                filter={sourceState.filter}
                setFilter={sourceState.setFilter}
                people={people}
                me={assigneeFilter.me}
                assigneesSupported={assigneeFilter.supported}
                assignee={assignee}
                setAssignee={assigneeFilter.setFilter}
                labels={labels}
                label={label}
                setLabel={labelFilter.setFilter}
                viewMode={prefs.viewMode}
                changeViewMode={prefs.changeViewMode}
                query={query}
                setQuery={setQuery}
                loading={list.loading}
                updatedAt={list.updatedAt}
                createTask={list.createTask}
                refresh={() => (sourceState.collections?.length ? loadTasks() : sourceState.reloadCollections())}
                onOpenSettings={onOpenSettings}
            />

            {connections === undefined && !sourceError && <SkeletonRows dot={false} label="Loading the task managers" />}
            {connections?.length === 0 && !sourceError && (
                <EmptyState
                    icon={ListTodo}
                    title="No task manager"
                    actions={
                        <Button variant="primary" size="lg" onClick={onOpenSettings}>
                            Open Settings › Task managers
                        </Button>
                    }
                    hint="Then “Start in worktree” gives a task to a new agent."
                >
                    Connect GitHub Issues, ClickUp, or a plugin to see your tasks here.
                </EmptyState>
            )}
            {currentConnection && !currentConnection.configured && (
                <EmptyState
                    icon={Settings}
                    title={`Set up ${currentConnection.name}`}
                    actions={
                        <Button variant="primary" size="lg" onClick={onOpenSettings}>
                            Open the settings
                        </Button>
                    }
                >
                    {currentConnection.name} needs its {missingSettingsText(currentConnection)}.
                </EmptyState>
            )}
            {currentConnection?.configured && source === undefined && !sourceError && <SkeletonRows label={`Starting ${currentConnection.name}`} />}
            {sourceError && (
                <EmptyState
                    icon={CircleAlert}
                    title="The task manager has an error"
                    actions={
                        <Button variant="primary" size="lg" onClick={onOpenSettings}>
                            Open the settings
                        </Button>
                    }
                >
                    {sourceError}
                </EmptyState>
            )}

            {source && listState === 'choose' && (
                <EmptyState icon={FolderSearch} title="Select a collection">
                    {source.name} has no default collection for this project. Select a collection in the header to see its tasks.
                </EmptyState>
            )}
            {source && listState === 'empty' && (
                <EmptyState
                    icon={FolderSearch}
                    title="No collections"
                    actions={
                        <Button variant="primary" size="lg" onClick={onOpenSettings}>
                            Open Settings › Task managers
                        </Button>
                    }
                >
                    {source.name} has no collections that you can access. Check the scope of the task manager in the settings.
                </EmptyState>
            )}

            {source && listState !== 'choose' && listState !== 'empty' && prefs.viewMode === 'board' && (
                <div className="tasks-body board-mode">
                    <div className="task-board">
                        <InlineTip id="tasks" />
                        {listError && <div className="form-error task-list-error">{listError}</div>}
                        {listed === undefined && !listError && <SkeletonRows label="Loading tasks" />}
                        {listed !== undefined && (
                            <div className="board-columns">
                                <TaskBoardColumns {...itemProps} columns={columns} canMove={canMove} moving={list.moving} onMove={moveTask} />
                            </div>
                        )}
                    </div>
                </div>
            )}

            {source && listState !== 'choose' && listState !== 'empty' && prefs.viewMode === 'list' && (
                <div className="tasks-body">
                    <div className="task-list" onKeyDown={moveListFocus}>
                        <InlineTip id="tasks" inset />
                        {listError && <div className="form-error task-list-error">{listError}</div>}
                        {listed === undefined && !listError && <SkeletonRows label="Loading tasks" />}
                        {listed?.length === 0 && (
                            <EmptyState icon={ListTodo} title="No tasks">
                                This collection has no tasks.
                            </EmptyState>
                        )}
                        {!!listed?.length && shown.length === 0 && (
                            <EmptyState icon={SearchX} title="No matching tasks">
                                {noMatchText(query, assignee, label)}
                            </EmptyState>
                        )}
                        <TaskStatusGroups {...itemProps} groups={statusGroups} />
                    </div>
                </div>
            )}

            {/* The board and the list both show the details of the selected task in a large dialog. */}
            {source && selectedId && (
                <TaskDialog
                    dialogRef={detailRef}
                    label={detailState.detail ? taskLabel(detailState.detail) : 'Task'}
                    canClose={!detailState.editing}
                    onClose={() => setSelectedId(undefined)}
                >
                    {detailContent}
                </TaskDialog>
            )}
        </div>
    );
}
