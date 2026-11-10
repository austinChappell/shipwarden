import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { X } from 'lucide-react';
import { boardColumns, groupTasksByStatus, taskMatches, type StatusGroup, type Task, type TaskLink } from '@shared/tasks';
import { ResizeHandle, usePanelWidth } from './ResizeHandle';
import { moveListFocus } from '../keyboard/list-nav';
import { missingSettingsText, worktreeForTask } from './tasks/task-view-logic';
import { useTaskSource } from './tasks/use-task-source';
import { useTaskList } from './tasks/use-task-list';
import { useTaskDetail } from './tasks/use-task-detail';
import { useTaskViewPrefs } from './tasks/use-task-view-prefs';
import { TasksHeader } from './tasks/TasksHeader';
import { TaskStatusGroups } from './tasks/TaskList';
import { TaskBoardColumns } from './tasks/TaskBoard';
import { TaskDetails } from './tasks/TaskDetails';

/** The smallest width of the task details when the user drags the border of the task list. */
const MIN_DETAIL_WIDTH = 320;

interface Props {
    /** The ShipWarden project. The view uses it only for the repository of "Start in worktree". */
    projectId: string;
    /** The repositories of the project. "Start in worktree" makes the worktree in one of them. */
    repos: string[];
    /** The task of each worktree, by worktree path. */
    links: Record<string, TaskLink>;
    onStartTask(task: Task, connectionId: string, pluginId: string, repo: string): Promise<void>;
    onOpenWorktree(path: string): void;
    /** The name of a repository: its name from the repository settings, else its folder name. */
    repoLabel(repo: string): string;
    /** Opens Settings, where the user configures the task managers. */
    onOpenSettings(): void;
    /** A task to open, for example from the task link of a worktree. A new `nonce` opens it again. */
    openTask?: { connectionId: string; taskId: string; nonce: number };
}

/** The tasks of the project's task managers, one collection at a time, with a detail pane for the selected task. */
export function TasksView({ projectId, repos, links, onStartTask, onOpenWorktree, onOpenSettings, repoLabel, openTask }: Props) {
    const [selectedId, setSelectedId] = useState<string>();
    const [query, setQuery] = useState('');
    const listWidth = usePanelWidth('shipwarden.width.taskList', 460, 300, 900);
    const boardDetailWidth = usePanelWidth('shipwarden.width.taskBoardDetail', 420, 320, 800);

    const sourceState = useTaskSource(setSelectedId);
    const { connections, connectionId, source, sourceError, collection, request } = sourceState;
    const prefs = useTaskViewPrefs(projectId, source?.pluginId);
    const list = useTaskList({ source, collection, filter: sourceState.filter, request, setSelectedId });
    const { tasks, loadTasks } = list;
    const listError = sourceState.collectionsError ?? list.listError;
    const detailState = useTaskDetail({ source, selectedId, setSelectedId, request, setTasks: list.setTasks, loadTasks });

    /**
     * An open request: select its task manager, then the task when the plugin of that task manager is ready.
     * The task shows in the details also when it is not in the selected collection.
     */
    const pendingOpen = useRef<{ connectionId: string; taskId: string } | undefined>(undefined);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Only a new nonce opens a task. A change of connection must not open the same task again.
    useEffect(() => {
        if (!openTask) return;
        if (openTask.connectionId === connectionId && source?.connectionId === connectionId) {
            setSelectedId(openTask.taskId);
            return;
        }
        pendingOpen.current = { connectionId: openTask.connectionId, taskId: openTask.taskId };
        if (openTask.connectionId !== connectionId) {
            sourceState.selectConnection(openTask.connectionId);
        }
    }, [openTask?.nonce]);
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

    const shown = useMemo(() => (tasks ?? []).filter(task => taskMatches(task, query)), [tasks, query]);
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
                viewMode={prefs.viewMode}
                changeViewMode={prefs.changeViewMode}
                query={query}
                setQuery={setQuery}
                loading={list.loading}
                createTask={list.createTask}
                refresh={() => (sourceState.collections?.length ? loadTasks() : sourceState.reloadCollections())}
                onOpenSettings={onOpenSettings}
            />

            {connections === undefined && !sourceError && <div className="panel-message">Loading the task managers…</div>}
            {connections?.length === 0 && !sourceError && (
                <div className="panel-message">
                    <p>This project has no task managers.</p>
                    <button className="button primary" onClick={onOpenSettings}>
                        Set up task managers
                    </button>
                </div>
            )}
            {currentConnection && !currentConnection.configured && (
                <div className="panel-message">
                    <p>
                        {currentConnection.name} needs its {missingSettingsText(currentConnection)}.
                    </p>
                    <button className="button primary" onClick={onOpenSettings}>
                        Open the settings
                    </button>
                </div>
            )}
            {currentConnection?.configured && source === undefined && !sourceError && <div className="panel-message">Starting {currentConnection.name}…</div>}
            {sourceError && (
                <div className="panel-message">
                    <div className="form-error">{sourceError}</div>
                    <button className="button" onClick={onOpenSettings}>
                        Open the settings
                    </button>
                </div>
            )}

            {source && prefs.viewMode === 'board' && (
                <div className="tasks-body board-mode">
                    <div className="task-board">
                        {listError && <div className="form-error task-list-error">{listError}</div>}
                        {tasks === undefined && !listError && <div className="panel-message">Loading tasks…</div>}
                        {tasks !== undefined && (
                            <div className="board-columns">
                                <TaskBoardColumns {...itemProps} columns={columns} canMove={canMove} moving={list.moving} onMove={moveTask} />
                            </div>
                        )}
                    </div>
                    {selectedId && (
                        <>
                            <ResizeHandle
                                panel={boardDetailWidth}
                                edge="left"
                                label="Resize the task details"
                                maxAvailable={() => (document.querySelector<HTMLElement>('.tasks-body')?.offsetWidth ?? Infinity) - 280}
                            />
                            <div className="task-detail board-detail" ref={detailRef} tabIndex={-1} style={{ width: boardDetailWidth.width }}>
                                <button className="icon-button board-detail-close" title="Close the details" onClick={() => setSelectedId(undefined)}>
                                    <X size={15} strokeWidth={1.75} />
                                </button>
                                {detailContent}
                            </div>
                        </>
                    )}
                </div>
            )}

            {source && prefs.viewMode === 'list' && (
                <div className="tasks-body" style={{ '--task-list-width': `${listWidth.width}px` } as CSSProperties}>
                    <div className="task-list" onKeyDown={moveListFocus}>
                        {listError && <div className="form-error task-list-error">{listError}</div>}
                        {tasks === undefined && !listError && <div className="panel-message">Loading tasks…</div>}
                        {tasks?.length === 0 && <div className="panel-message">No tasks in this collection.</div>}
                        {!!tasks?.length && shown.length === 0 && <div className="panel-message">No tasks match “{query.trim()}”.</div>}
                        <TaskStatusGroups {...itemProps} groups={statusGroups} />
                    </div>
                    <ResizeHandle
                        panel={listWidth}
                        edge="right"
                        label="Resize the task list"
                        maxAvailable={() => (document.querySelector<HTMLElement>('.tasks-body')?.offsetWidth ?? Infinity) - MIN_DETAIL_WIDTH}
                    />
                    <div className="task-detail" ref={detailRef} tabIndex={-1}>
                        {detailContent}
                    </div>
                </div>
            )}
        </div>
    );
}
