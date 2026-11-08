import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronRight, ExternalLink, GitBranch, List, LoaderCircle, Play, RefreshCw, Search, Settings, SquareKanban, X } from 'lucide-react';
import {
    boardColumns,
    collapsedByDefault,
    groupTasksByStatus,
    linkMatchesTask,
    pickCollection,
    sortCollections,
    statusForColumn,
    statusKey,
    type TaskCollection,
    type StatusGroup,
    type StatusOrder,
    type ConnectionInfo,
    type Task,
    type TaskComment,
    type TaskLink,
    type TaskSource,
    type TaskStatus
} from '@shared/tasks';
import { errorText, timeAgo } from '../util';
import { taskSeenKey } from '@shared/dashboard';
import { seenStore } from '../seen-store';
import { Combobox, sortedGroups } from './Combobox';
import { Markdown } from './Markdown';
import { ResizeHandle, usePanelWidth } from './ResizeHandle';
import { alertDialog, confirmDialog } from './ConfirmDialog';

/** The smallest width of the task details when the user drags the border of the task list. */
const MIN_DETAIL_WIDTH = 320;

interface Props {
    /** The ShipWarden project. Its task managers decide the connections of the view. */
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

const api = window.shipwarden.tasks;
const POLL_MS = 60_000;
/** The list loads at most this number of pages. ClickUp sends 100 tasks per page. */
const MAX_PAGES = 5;

/** The groups that the user opened or collapsed, by status key. Each plugin has its own record. */
type CollapseState = Record<string, boolean>;

function collapseStorageKey(pluginId: string): string {
    return `shipwarden.collapsedStatuses.${pluginId}`;
}

type ViewMode = 'list' | 'board';
const VIEW_STORAGE_KEY = 'shipwarden.tasksView';



/** The board is the default view. The list shows only when the user selected it. */
function readViewMode(): ViewMode {
    try {
        return localStorage.getItem(VIEW_STORAGE_KEY) === 'list' ? 'list' : 'board';
    } catch {
        return 'board';
    }
}

function readCollapseState(pluginId: string): CollapseState {
    try {
        return JSON.parse(localStorage.getItem(collapseStorageKey(pluginId)) ?? '{}') as CollapseState;
    } catch {
        return {};
    }
}

function StatusDot({ status }: { status: TaskStatus }) {
    return <span className={`task-status-dot ${status.category}`} style={status.color ? { background: status.color } : undefined} title={status.name} />;
}

function formatField(value: string | number | boolean | null | undefined, type: string): string {
    if (value === null || value === undefined || value === '') return '—';
    if (type === 'date' && typeof value === 'string') return new Date(value).toLocaleDateString();
    if (type === 'boolean') return value ? 'Yes' : 'No';
    return String(value);
}

/** The repository that "Start in worktree" used last in a project. */
function startRepoKey(projectId: string): string {
    return `shipwarden.startRepo:${projectId}`;
}

/** The tasks of the project's task managers, one collection at a time, with a detail pane for the selected task. */
export function TasksView({ projectId, repos, links, onStartTask, onOpenWorktree, onOpenSettings, repoLabel, openTask }: Props) {
    /** The task managers (connections) of the project. */
    const [connections, setConnections] = useState<ConnectionInfo[]>();
    const [connectionId, setConnectionId] = useState<string>();
    const [sourceError, setSourceError] = useState<string>();
    /** The repository for "Start in worktree", when the project has several. */
    const [startRepo, setStartRepo] = useState<string>(() => {
        try {
            return localStorage.getItem(startRepoKey(projectId)) ?? '';
        } catch {
            return '';
        }
    });
    const [filter, setFilter] = useState<string>();
    const [query, setQuery] = useState('');
    const [tasks, setTasks] = useState<Task[]>();
    const [loading, setLoading] = useState(false);
    const [listError, setListError] = useState<string>();
    const [selectedId, setSelectedId] = useState<string>();
    const listWidth = usePanelWidth('shipwarden.width.taskList', 460, 300, 900);
    const boardDetailWidth = usePanelWidth('shipwarden.width.taskBoardDetail', 420, 320, 800);
    const [detail, setDetail] = useState<Task>();
    const [statuses, setStatuses] = useState<TaskStatus[]>([]);
    const [comments, setComments] = useState<TaskComment[]>([]);
    const [commentText, setCommentText] = useState('');
    const [busy, setBusy] = useState(false);
    const [detailError, setDetailError] = useState<string>();
    const [collapsed, setCollapsed] = useState<CollapseState>({});
    /** The workflow order of the statuses from the plugin's status order adapter, if it has one. */
    const [statusOrder, setStatusOrder] = useState<StatusOrder>();
    /** The list (grouped) or the board (a column for each status). */
    const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);
    /** The task that the user drags on the board. */
    const [dragging, setDragging] = useState<Task>();
    /** The board column under the dragged card. */
    const [dropTarget, setDropTarget] = useState<string>();
    /** The tasks that move to another status now. */
    const [moving, setMoving] = useState<Set<string>>(new Set());
    /** The collections of the task source, for example ClickUp lists or GitHub repositories. */
    const [collections, setCollections] = useState<TaskCollection[]>();
    /** The collection that the view shows. */
    /**
     * The selected collection, with the connection that it belongs to. During a switch to another connection, the old
     * collection is still in state for one render. It must not go to the new connection, so it counts only for its own.
     */
    const [selection, setSelection] = useState<{ connectionId: string; id: string }>();
    const [source, setSource] = useState<TaskSource | null>();
    const collection = source && selection?.connectionId === source.connectionId ? selection.id : undefined;
    /** Changes when the user asks to load the collections again, for example after a failed request. */
    const [collectionsKey, setCollectionsKey] = useState(0);

    useEffect(() => {
        setCollapsed(source ? readCollapseState(source.pluginId) : {});
    }, [source?.pluginId]);

    const changeViewMode = (value: ViewMode) => {
        setViewMode(value);
        try {
            localStorage.setItem(VIEW_STORAGE_KEY, value);
        } catch {
            // The choice stays for this session only.
        }
    };

    /** Selects a collection. The main process remembers it for the task source, in all repositories and after a restart. */
    const selectCollection = (id: string) => {
        if (source) {
            setSelection({ connectionId: source.connectionId, id });
        }
        setSelectedId(undefined);
        if (source) {
            api.setSelectedCollection(source.connectionId, id).catch(() => undefined);
        }
    };

    /** `key` identifies the group: the status key, or "board:<status key>" for a board column. */
    const isCollapsed = (key: string, byDefault: boolean) => collapsed[key] ?? byDefault;

    const toggleGroup = (key: string, byDefault: boolean) => {
        if (!source) return;
        const next = { ...collapsed, [key]: !isCollapsed(key, byDefault) };
        setCollapsed(next);
        try {
            localStorage.setItem(collapseStorageKey(source.pluginId), JSON.stringify(next));
        } catch {
            // The state stays for this session only.
        }
    };

    const request = useCallback(<T,>(method: string, params: unknown) => {
        if (!connectionId) {
            return Promise.reject(new Error('Select a task manager.'));
        }
        return api.request(connectionId, projectId, method, params) as Promise<T>;
    }, [connectionId, projectId]);

    // Load the task managers of the project, and select the last one that the user showed in this project.
    useEffect(() => {
        let cancelled = false;
        setConnections(undefined);
        Promise.all([api.enabledConnections(), api.selectedConnection(projectId).catch(() => undefined)]).then(([list, saved]) => {
            if (cancelled) return;
            setConnections(list);
            const usable = list.filter(item => item.configured);
            setConnectionId((saved && list.some(item => item.id === saved) ? saved : undefined) ?? usable[0]?.id ?? list[0]?.id);
        }, err => {
            if (!cancelled) {
                setConnections([]);
                setSourceError(errorText(err));
            }
        });
        return () => {
            cancelled = true;
        };
        // The view opens again after a visit to Settings, so it loads the task managers again then.
    }, [projectId]);

    // Start the plugin of the selected task manager.
    useEffect(() => {
        let cancelled = false;
        setSource(undefined);
        setSourceError(undefined);
        setTasks(undefined);
        setSelectedId(undefined);
        const connection = connections?.find(item => item.id === connectionId);
        if (!connection) {
            setSource(connections ? null : undefined);
            return;
        }
        if (!connection.configured) {
            setSource(null);
            return;
        }
        api.source(connection.id, projectId).then(started => {
            if (cancelled) return;
            setSource(started);
            // Each source has its own filters. Two sources can use the same filter ID with another meaning, so start with the default.
            setFilter(started.filters.find(item => item.default)?.id ?? started.filters[0]?.id);
        }, err => {
            if (!cancelled) {
                setSourceError(errorText(err));
                setSource(null);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [connections, connectionId, projectId]);

    const selectConnection = (id: string) => {
        setConnectionId(id);
        api.setSelectedConnection(projectId, id).catch(() => undefined);
    };

    // Load the collections of the source and select the saved one, the plugin's default or the first one.
    useEffect(() => {
        setCollections(undefined);
        setSelection(undefined);
        // After a switch, the old source is still in state for one render. Load only for the selected connection.
        if (!source || source.connectionId !== connectionId) return;
        let cancelled = false;
        Promise.all([
            request<TaskCollection[]>('collections/list', {}),
            api.selectedCollection(source.connectionId).catch(() => undefined)
        ]).then(([list, saved]) => {
            if (cancelled) return;
            const sorted = sortCollections(list);
            setCollections(sorted);
            const picked = pickCollection(sorted, saved);
            setSelection(picked ? { connectionId: source.connectionId, id: picked } : undefined);
        }, err => {
            if (!cancelled) {
                setCollections([]);
                setListError(errorText(err));
            }
        });
        return () => {
            cancelled = true;
        };
    }, [source, connectionId, request, collectionsKey]);

    // A new collection starts empty, so tasks of the old collection do not show for a moment.
    useEffect(() => {
        setTasks(undefined);
        setStatusOrder(undefined);
        setListError(undefined);
    }, [collection]);

    const loadTasks = useCallback(async () => {
        // After a switch, the old source is still in state for one render. Load only for the selected connection.
        if (!source || !collection || source.connectionId !== connectionId) return;
        setLoading(true);
        try {
            const all: Task[] = [];
            let cursor: string | undefined;
            for (let page = 0; page < MAX_PAGES; page++) {
                const result = await request<{ tasks: Task[]; nextCursor?: string }>('tasks/list', { collection, filter, query: query.trim() || undefined, cursor });
                all.push(...result.tasks);
                cursor = result.nextCursor;
                if (!cursor) {
                    break;
                }
            }
            // A task can be on two pages when it changes during the load. Keep its first copy.
            setTasks(all.filter((task, index) => all.findIndex(other => other.id === task.id) === index));
            if (source.capabilities.statusOrder) {
                request<StatusOrder>('tasks/statusOrder', { collection }).then(
                    result => setStatusOrder(result),
                    () => setStatusOrder(undefined)
                );
            }
            setListError(undefined);
        } catch (err) {
            setListError(errorText(err));
        } finally {
            setLoading(false);
        }
    }, [source, collection, connectionId, filter, query, request]);

    // Load the list after a short pause in typing, and again on a timer and on change notifications.
    useEffect(() => {
        const timer = setTimeout(loadTasks, query ? 300 : 0);
        return () => clearTimeout(timer);
    }, [loadTasks, query]);
    useEffect(() => {
        const timer = setInterval(loadTasks, POLL_MS);
        const off = api.onChanged((changedConnection, changedProject) => changedConnection === connectionId && changedProject === projectId && loadTasks());
        return () => {
            clearInterval(timer);
            off();
        };
    }, [loadTasks, connectionId, projectId]);

    const loadDetail = useCallback(async (id: string) => {
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
            // The comments of an open task count as seen on the Dashboard.
            if (source) {
                seenStore.mark(commentList.map(comment => taskSeenKey(source.connectionId, comment.id)));
            }
        } catch (err) {
            setDetailError(errorText(err));
        }
    }, [request, source]);

    useEffect(() => {
        setDetail(undefined);
        setComments([]);
        setStatuses([]);
        if (selectedId) {
            loadDetail(selectedId);
        }
    }, [selectedId, loadDetail]);

    /**
     * An open request: select its task manager, then the task when the plugin of that task manager is ready.
     * The task shows in the details also when it is not in the selected collection.
     */
    const pendingOpen = useRef<{ connectionId: string; taskId: string } | undefined>(undefined);
    useEffect(() => {
        if (!openTask) return;
        if (openTask.connectionId === connectionId && source?.connectionId === connectionId) {
            setSelectedId(openTask.taskId);
            return;
        }
        pendingOpen.current = { connectionId: openTask.connectionId, taskId: openTask.taskId };
        if (openTask.connectionId !== connectionId) {
            selectConnection(openTask.connectionId);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openTask?.nonce]);
    useEffect(() => {
        const pending = pendingOpen.current;
        if (pending && source && source.connectionId === pending.connectionId) {
            pendingOpen.current = undefined;
            setSelectedId(pending.taskId);
        }
    }, [source]);

    /** The worktree button of a task card or row. It opens the worktree, not the task. */
    const worktreeButton = (worktree: string) => (
        <button
            className="icon-button task-linked"
            title="Open the worktree of this task"
            onClick={event => {
                event.stopPropagation();
                onOpenWorktree(worktree);
            }}
        >
            <GitBranch size={13} strokeWidth={1.6} />
        </button>
    );

    const linkedWorktree = (task: Task) => Object.entries(links).find(([, link]) => linkMatchesTask(link, source?.connectionId, task))?.[0];

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

    const changeStatus = (statusId: string) => detail && act(async () => {
        const updated = await request<Task>('tasks/update', { id: detail.id, status: statusId });
        setDetail(updated);
        setTasks(list => list?.map(task => (task.id === updated.id ? { ...task, status: updated.status } : task)));
    });

    const addComment = () => detail && commentText.trim() && act(async () => {
        const created = await request<TaskComment>('comments/create', { taskId: detail.id, body: commentText.trim() });
        setComments(list => [...list, created]);
        setCommentText('');
    });

    const runAction = (actionId: string, confirmText?: string) => detail && act(async () => {
        if (confirmText && !(await confirmDialog({ title: confirmText }))) return;
        const result = await request<{ message?: string }>('tasks/action', { taskId: detail.id, actionId });
        if (result?.message) await alertDialog(result.message);
        await loadDetail(detail.id);
    });

    const shown = tasks ?? [];
    const statusGroups = useMemo(() => groupTasksByStatus(shown, statusOrder?.statuses), [shown, statusOrder]);
    /** The board has a column for each status of the collection's workflow, also without tasks, so a card can move to it. */
    const columns = useMemo(() => boardColumns(shown, statusOrder?.statuses), [shown, statusOrder]);
    const current = collections?.find(item => item.id === collection);
    /** The picker groups the collections by path, for example a ClickUp space and folder or a GitHub owner. */
    const pickerGroups = useMemo(() => sortedGroups(collections ?? [], item => item.path ?? '', item => ({ value: item.id, label: item.name })), [collections]);
    const canMove = !!source?.capabilities.update && !!source?.capabilities.statuses;

    /**
     * Moves a task to the status of a board column. The status comes from the task's own workflow,
     * because each ClickUp list can have its own statuses.
     */
    const moveTask = async (task: Task, column: StatusGroup) => {
        if (statusKey(task.status.name) === column.key || moving.has(task.id)) {
            return;
        }
        const setStatus = (status: TaskStatus) => setTasks(list => list?.map(item => (item.id === task.id ? { ...item, status } : item)));
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
            if (detail?.id === updated.id) {
                setDetail(updated);
            }
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

    const renderTask = (task: Task) => {
        const worktree = linkedWorktree(task);
        return (
            <div key={task.id} className={`task-row${task.id === selectedId ? ' selected' : ''}`} onClick={() => setSelectedId(task.id)}>
                <StatusDot status={task.status} />
                {task.key && <span className="task-key">{task.key}</span>}
                <span className="task-title">{task.title}</span>
                {worktree && worktreeButton(worktree)}
                {task.labels?.slice(0, 2).map(label => (
                    <span key={label.name} className="task-label" style={label.color ? { borderColor: label.color } : undefined}>{label.name}</span>
                ))}
            </div>
        );
    };

    const renderStatusGroups = (groups: StatusGroup[]) => groups.map(group => {
        const key = group.key;
        const closed = isCollapsed(key, collapsedByDefault(group.category));
        return (
            <section key={key}>
                <button className="status-group" aria-expanded={!closed} onClick={() => toggleGroup(key, collapsedByDefault(group.category))}>
                    <ChevronRight size={14} strokeWidth={1.8} className={`group-chevron${closed ? '' : ' open'}`} />
                    <StatusDot status={{ id: group.key, name: group.name, color: group.color, category: group.category }} />
                    <span className="status-group-name">{group.name}</span>
                    <span className="status-group-count">{group.tasks.length}</span>
                </button>
                {!closed && group.tasks.map(renderTask)}
            </section>
        );
    });
    const currentConnection = connections?.find(item => item.id === connectionId);
    /** The repository for "Start in worktree": the last one in this project, else the first. */
    const targetRepo = repos.includes(startRepo) ? startRepo : repos[0];
    const chooseStartRepo = (repo: string) => {
        setStartRepo(repo);
        try {
            localStorage.setItem(startRepoKey(projectId), repo);
        } catch {
            // The choice stays for this session only.
        }
    };

    const renderCard = (task: Task) => {
        const worktree = linkedWorktree(task);
        const isMoving = moving.has(task.id);
        return (
            <div
                key={task.id}
                className={`board-card${task.id === selectedId ? ' selected' : ''}${isMoving ? ' moving' : ''}${dragging?.id === task.id ? ' dragging' : ''}`}
                draggable={canMove && !isMoving}
                title={canMove ? 'Drag to another column to change the status' : undefined}
                onDragStart={event => {
                    event.dataTransfer.setData('text/plain', task.id);
                    event.dataTransfer.effectAllowed = 'move';
                    setDragging(task);
                }}
                onDragEnd={() => {
                    setDragging(undefined);
                    setDropTarget(undefined);
                }}
                onClick={() => setSelectedId(task.id)}
            >
                <div className="board-card-top">
                    {task.key && <span className="task-key">{task.key}</span>}
                    <span className="header-spacer" />
                    {isMoving && <LoaderCircle size={12} className="spin" />}
                    {worktree && worktreeButton(worktree)}
                </div>
                <div className="board-card-title">{task.title}</div>
                {!!task.labels?.length && (
                    <div className="board-card-meta">
                        {task.labels?.slice(0, 2).map(label => (
                            <span key={label.name} className="task-label" style={label.color ? { borderColor: label.color } : undefined}>{label.name}</span>
                        ))}
                    </div>
                )}
            </div>
        );
    };

    const renderColumn = (column: StatusGroup) => {
        const key = `board:${column.key}`;
        const closed = isCollapsed(key, collapsedByDefault(column.category));
        const accepts = canMove && !!dragging && statusKey(dragging.status.name) !== column.key;
        return (
            <section
                key={column.key}
                className={`board-column${closed ? ' collapsed' : ''}${accepts && dropTarget === column.key ? ' drop-target' : ''}`}
                onDragOver={event => {
                    if (accepts) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                        setDropTarget(column.key);
                    }
                }}
                onDragLeave={event => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        setDropTarget(target => (target === column.key ? undefined : target));
                    }
                }}
                onDrop={event => {
                    event.preventDefault();
                    setDropTarget(undefined);
                    if (dragging && accepts) {
                        moveTask(dragging, column);
                    }
                    setDragging(undefined);
                }}
            >
                <button
                    className="board-column-header"
                    aria-expanded={!closed}
                    title={closed ? `Show ${column.name}` : `Collapse ${column.name}`}
                    onClick={() => toggleGroup(key, collapsedByDefault(column.category))}
                >
                    <StatusDot status={{ id: column.key, name: column.name, color: column.color, category: column.category }} />
                    <span className="board-column-name">{column.name}</span>
                    <span className="status-group-count">{column.tasks.length}</span>
                </button>
                {!closed && (
                    <div className="board-cards">
                        {column.tasks.map(renderCard)}
                        {column.tasks.length === 0 && <div className="board-empty">{accepts ? 'Drop here' : 'No tasks'}</div>}
                    </div>
                )}
            </section>
        );
    };

    /** The detail panel of the selected task. The list and the board both show it at the right. */
    const detailContent = source && (
        <>
            {!selectedId && <div className="panel-message">Select a task.</div>}
            {selectedId && !detail && !detailError && <div className="panel-message"><LoaderCircle size={14} className="spin" /> Loading…</div>}
            {detailError && <div className="form-error task-detail-error">{detailError}</div>}
            {detail && (
                <div className="task-detail-scroll">
                    <div className="task-detail-top">
                        {detail.key && <span className="task-key">{detail.key}</span>}
                        {detail.url && (
                            <button className="link-button" onClick={() => window.shipwarden.github.openInBrowser(detail.url!)}>
                                Open <ExternalLink size={12} strokeWidth={1.6} />
                            </button>
                        )}
                    </div>
                    <h2 className="task-detail-title">{detail.title}</h2>

                    <div className="task-start">
                        {linkedWorktree(detail) ? (
                            <button className="button primary" onClick={() => onOpenWorktree(linkedWorktree(detail)!)}>
                                <GitBranch size={14} strokeWidth={1.8} />Open worktree
                            </button>
                        ) : (
                            <>
                                <button
                                    className="button primary"
                                    disabled={busy || !targetRepo || !source}
                                    title={targetRepo ? `Make a worktree in ${repoLabel(targetRepo)} and start an agent on the task` : 'Add a repository to the project first'}
                                    onClick={() => source && targetRepo && act(() => onStartTask(detail, source.connectionId, source.pluginId, targetRepo))}
                                >
                                    <Play size={14} strokeWidth={1.8} />Start in worktree
                                </button>
                                {repos.length > 1 && (
                                    <select className="tasks-select" value={targetRepo} title="The repository of the new worktree" onChange={event => chooseStartRepo(event.target.value)}>
                                        {repos.map(repo => <option key={repo} value={repo}>{repoLabel(repo)}</option>)}
                                    </select>
                                )}
                            </>
                        )}
                        {source.actions.map(action => (
                            <button key={action.id} className="button" disabled={busy} onClick={() => runAction(action.id, action.confirm)}>{action.label}</button>
                        ))}
                    </div>

                    <div className="task-meta">
                        <span className="task-meta-label">Status</span>
                        {source.capabilities.update && statuses.length > 0 ? (
                            <select className="tasks-select" value={detail.status.id} disabled={busy} onChange={event => changeStatus(event.target.value)}>
                                {statuses.map(status => <option key={status.id} value={status.id}>{status.name}</option>)}
                            </select>
                        ) : (
                            <span><StatusDot status={detail.status} /> {detail.status.name}</span>
                        )}
                        <span className="task-meta-label">Assignees</span>
                        <span>{detail.assignees?.length ? detail.assignees.map(person => person.name).join(', ') : '—'}</span>
                        {detail.priority && (
                            <>
                                <span className="task-meta-label">Priority</span>
                                <span>{detail.priority.name}</span>
                            </>
                        )}
                        {detail.labels && detail.labels.length > 0 && (
                            <>
                                <span className="task-meta-label">Labels</span>
                                <span className="task-labels">{detail.labels.map(label => (
                                    <span key={label.name} className="task-label" style={label.color ? { borderColor: label.color } : undefined}>{label.name}</span>
                                ))}</span>
                            </>
                        )}
                        {source.fields.map(field => (
                            <FieldRow key={field.id} label={field.label} value={formatField(detail.fields?.[field.id], field.type)} />
                        ))}
                        {detail.updatedAt && (
                            <>
                                <span className="task-meta-label">Updated</span>
                                <span>{timeAgo(detail.updatedAt)}</span>
                            </>
                        )}
                    </div>

                    {detail.description?.trim()
                        ? <Markdown className="task-description" text={detail.description} />
                        : <div className="task-description">No description.</div>}

                    {source.capabilities.comments && (
                        <section className="task-comments">
                            <div className="section-title">Comments <span>{comments.length}</span></div>
                            {comments.map(comment => (
                                <div key={comment.id} className="thread-comment">
                                    <div className="comment-author">{comment.author?.name ?? 'unknown'} {comment.createdAt && <span>{timeAgo(comment.createdAt)}</span>}</div>
                                    <Markdown className="comment-body" text={comment.body} />
                                </div>
                            ))}
                            <textarea className="review-body" value={commentText} placeholder="Add a comment" onChange={event => setCommentText(event.target.value)} />
                            <div className="row-buttons">
                                <button className="button" disabled={busy || !commentText.trim()} onClick={addComment}>Comment</button>
                            </div>
                        </section>
                    )}
                </div>
            )}
        </>
    );

    return (
        <div className="tasks-view">
            <header className="tasks-header">
                {/* Two groups: where the tasks come from, and how they show. A narrow window puts the second group on its own row. */}
                <div className="tasks-header-group where">
                    {connections && connections.length > 0 && (
                        <select className="tasks-select" value={connectionId ?? ''} onChange={event => selectConnection(event.target.value)} title="Task manager">
                            {connections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </select>
                    )}
                    {source && (
                        <div className="collection-picker">
                            <Combobox
                                className="collection-select"
                                value={collection}
                                groups={pickerGroups}
                                placeholder={!collections ? 'Loading collections…' : collections.length === 0 ? 'No collections' : 'Select a collection'}
                                searchPlaceholder="Search collections"
                                disabled={!collections?.length}
                                title={current ? `Collection: ${current.path ? `${current.path} / ` : ''}${current.name}` : 'Collection'}
                                onChange={selectCollection}
                            />
                            {current?.url && (
                                <button className="icon-button collection-open" title="Open the collection in the browser" onClick={() => window.shipwarden.github.openInBrowser(current.url!)}>
                                    <ExternalLink size={14} strokeWidth={1.6} />
                                </button>
                            )}
                        </div>
                    )}
                </div>
                <div className="tasks-header-group how">
                    {source && source.filters.length > 0 && (
                        <select className="tasks-select" value={filter} onChange={event => setFilter(event.target.value)} title="Filter">
                            {source.filters.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                        </select>
                    )}
                    {source && (
                        <div className="segmented compact view-switch" role="group" aria-label="View">
                            <button className={viewMode === 'board' ? 'selected' : ''} title="Board" aria-label="Board" aria-pressed={viewMode === 'board'} onClick={() => changeViewMode('board')}>
                                <SquareKanban size={15} strokeWidth={1.8} />
                            </button>
                            <button className={viewMode === 'list' ? 'selected' : ''} title="List" aria-label="List" aria-pressed={viewMode === 'list'} onClick={() => changeViewMode('list')}>
                                <List size={15} strokeWidth={1.8} />
                            </button>
                        </div>
                    )}
                    {source && (
                        <label className="tasks-search">
                            <Search size={14} strokeWidth={1.6} />
                            <input value={query} placeholder="Search tasks" spellCheck={false} onChange={event => setQuery(event.target.value)} />
                        </label>
                    )}
                    <span className="header-spacer" />
                    {source && (
                        <button
                            className="icon-button"
                            title="Refresh"
                            onClick={() => (collections?.length ? loadTasks() : setCollectionsKey(key => key + 1))}
                        >
                            <RefreshCw size={15} strokeWidth={1.6} className={loading ? 'spin' : ''} />
                        </button>
                    )}
                    {currentConnection && (
                        <button className="icon-button" title="Task manager settings" onClick={onOpenSettings}>
                            <Settings size={15} strokeWidth={1.6} />
                        </button>
                    )}
                </div>
            </header>

            {connections === undefined && !sourceError && <div className="panel-message">Loading the task managers…</div>}
            {connections?.length === 0 && !sourceError && (
                <div className="panel-message">
                    <p>This project has no task managers.</p>
                    <button className="button primary" onClick={onOpenSettings}>Set up task managers</button>
                </div>
            )}
            {currentConnection && !currentConnection.configured && (
                <div className="panel-message">
                    <p>{currentConnection.name} needs its {currentConnection.settings.filter(setting => setting.required).map(setting => setting.label.toLowerCase()).join(' and ') || 'settings'}.</p>
                    <button className="button primary" onClick={onOpenSettings}>Open the settings</button>
                </div>
            )}
            {currentConnection?.configured && source === undefined && !sourceError && <div className="panel-message">Starting {currentConnection.name}…</div>}
            {sourceError && (
                <div className="panel-message">
                    <div className="form-error">{sourceError}</div>
                    <button className="button" onClick={onOpenSettings}>Open the settings</button>
                </div>
            )}

            {source && viewMode === 'board' && (
                <div className="tasks-body board-mode">
                    <div className="task-board">
                        {listError && <div className="form-error task-list-error">{listError}</div>}
                        {tasks === undefined && !listError && <div className="panel-message">Loading tasks…</div>}
                        {tasks !== undefined && <div className="board-columns">{columns.map(renderColumn)}</div>}
                    </div>
                    {selectedId && (
                        <>
                            <ResizeHandle
                                panel={boardDetailWidth}
                                edge="left"
                                label="Resize the task details"
                                maxAvailable={() => (document.querySelector<HTMLElement>('.tasks-body')?.offsetWidth ?? Infinity) - 280}
                            />
                            <div className="task-detail board-detail" style={{ width: boardDetailWidth.width }}>
                                <button className="icon-button board-detail-close" title="Close the details" onClick={() => setSelectedId(undefined)}>
                                    <X size={15} strokeWidth={1.75} />
                                </button>
                                {detailContent}
                            </div>
                        </>
                    )}
                </div>
            )}

            {source && viewMode === 'list' && (
                <div className="tasks-body" style={{ '--task-list-width': `${listWidth.width}px` } as CSSProperties}>
                    <div className="task-list">
                        {listError && <div className="form-error task-list-error">{listError}</div>}
                        {tasks === undefined && !listError && <div className="panel-message">Loading tasks…</div>}
                        {tasks?.length === 0 && <div className="panel-message">No tasks in this collection.</div>}
                        {renderStatusGroups(statusGroups)}
                    </div>
                    <ResizeHandle
                        panel={listWidth}
                        edge="right"
                        label="Resize the task list"
                        maxAvailable={() => (document.querySelector<HTMLElement>('.tasks-body')?.offsetWidth ?? Infinity) - MIN_DETAIL_WIDTH}
                    />
                    <div className="task-detail">
                        {detailContent}
                    </div>
                </div>
            )}
        </div>
    );
}

function FieldRow({ label, value }: { label: string; value: string }) {
    return (
        <>
            <span className="task-meta-label">{label}</span>
            <span>{value}</span>
        </>
    );
}
