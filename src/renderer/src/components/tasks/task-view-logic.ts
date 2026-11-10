import type { ConnectionInfo, FilterDefinition, StatusGroup, Task, TaskCollection, TaskComment, TaskLink, TaskStatus } from '@shared/tasks';
import { linkMatchesTask, statusKey } from '@shared/tasks';

/** The list (grouped) or the board (a column for each status). */
export type ViewMode = 'list' | 'board';

/** The groups that the user opened or collapsed, by status key. Each plugin has its own record. */
export type CollapseState = Record<string, boolean>;

/** The state of the selected task manager. The plugin starts again only when this state changes. */
export type ConnectionState = 'loading' | 'none' | 'ready' | 'unconfigured';

export interface CachedDetail {
    task: Task;
    statuses: TaskStatus[];
    comments: TaskComment[];
}

export const VIEW_STORAGE_KEY = 'shipwarden.tasksView';

export function collapseStorageKey(pluginId: string): string {
    return `shipwarden.collapsedStatuses.${pluginId}`;
}

/** The repository that "Start in worktree" used last in a project. */
export function startRepoKey(projectId: string): string {
    return `shipwarden.startRepo:${projectId}`;
}

/** The last filter of each source, for the session. The view selects it again on the next visit, in all projects. */
const lastFilters = new Map<string, string>();
export const lastFilter = (connectionId: string) => lastFilters.get(connectionId);
export function rememberFilter(connectionId: string, filter: string): void {
    lastFilters.set(connectionId, filter);
}

/**
 * The query keys of the view. The query cache keeps the loaded data for the session.
 * The keys do not contain the project. All projects use the same task managers and the same task data,
 * so a project switch shows the cached data and sends no new requests.
 */
export const taskQueryKeys = {
    connections: () => ['tasks', 'connections'] as const,
    source: (connectionId: string | undefined) => ['tasks', 'source', connectionId] as const,
    collections: (connectionId: string | undefined) => ['tasks', 'collections', connectionId] as const,
    list: (connectionId: string | undefined, collection: string | undefined, filter: string | undefined) =>
        ['tasks', 'list', connectionId, collection, filter] as const,
    statusOrder: (connectionId: string | undefined, collection: string | undefined) => ['tasks', 'statusOrder', connectionId, collection] as const,
    detail: (connectionId: string | undefined, taskId: string | undefined) => ['tasks', 'detail', connectionId, taskId] as const
};

/** The board is the default view. The list shows only when the user selected it. */
export function parseViewMode(value: string | null): ViewMode {
    return value === 'list' ? 'list' : 'board';
}

/** Reads the stored collapse state. Text that is not valid JSON gives an empty record. */
export function parseCollapseState(value: string | null): CollapseState {
    try {
        return JSON.parse(value ?? '{}') as CollapseState;
    } catch {
        return {};
    }
}

/** `key` identifies the group: the status key, or "board:<status key>" for a board column. */
export function isGroupCollapsed(state: CollapseState, key: string, byDefault: boolean): boolean {
    return state[key] ?? byDefault;
}

/** Returns a new collapse state with the opposite value for the group. */
export function toggleCollapse(state: CollapseState, key: string, byDefault: boolean): CollapseState {
    return { ...state, [key]: !isGroupCollapsed(state, key, byDefault) };
}

export function formatField(value: string | number | boolean | null | undefined, type: string): string {
    if (value === null || value === undefined || value === '') return '—';
    if (type === 'date' && typeof value === 'string') return new Date(value).toLocaleDateString();
    if (type === 'boolean') return value ? 'Yes' : 'No';
    return String(value);
}

/** Returns the saved connection if the list has it. Else it returns the first configured connection, else the first one. */
export function pickConnection(list: readonly ConnectionInfo[], saved: string | undefined): string | undefined {
    const usable = list.filter(item => item.configured);
    return (saved && list.some(item => item.id === saved) ? saved : undefined) ?? usable[0]?.id ?? list[0]?.id;
}

export function connectionStateOf(connections: readonly ConnectionInfo[] | undefined, connectionId: string | undefined): ConnectionState {
    const selected = connections?.find(item => item.id === connectionId);
    return connections === undefined ? 'loading' : !selected ? 'none' : selected.configured ? 'ready' : 'unconfigured';
}

/**
 * Each source has its own filters. Two sources can use the same filter ID with another meaning.
 * Thus the view uses the last filter of this source, or the default filter of the source.
 */
export function pickFilter(filters: readonly FilterDefinition[], last: string | undefined): string | undefined {
    return last && filters.some(item => item.id === last) ? last : (filters.find(item => item.default)?.id ?? filters[0]?.id);
}

/** A task can be on two pages when it changes during the load. This function keeps its first copy. */
export function uniqueTasks(tasks: readonly Task[]): Task[] {
    return tasks.filter((task, index) => tasks.findIndex(other => other.id === task.id) === index);
}

/** Applies the changes to the task with the ID. The other tasks do not change. */
export function patchTask(tasks: readonly Task[] | undefined, id: string, patch: Partial<Task>): Task[] | undefined {
    return tasks?.map(task => (task.id === id ? { ...task, ...patch } : task));
}

/** Puts a new task at the start of the list. An old copy of the same task goes out of the list. */
export function prependTask(tasks: readonly Task[] | undefined, created: Task): Task[] {
    return [created, ...(tasks ?? []).filter(task => task.id !== created.id)];
}

export function removeTask(tasks: readonly Task[] | undefined, id: string): Task[] | undefined {
    return tasks?.filter(task => task.id !== id);
}

/** Returns the path of the worktree that works on the task, or undefined. */
export function worktreeForTask(links: Record<string, TaskLink>, connectionId: string | undefined, task: Pick<Task, 'id' | 'url'>): string | undefined {
    return Object.entries(links).find(([, link]) => linkMatchesTask(link, connectionId, task))?.[0];
}

/** Returns the board column next to the column of the task. `step` is -1 for the left column and 1 for the right column. */
export function neighborColumn(columns: readonly StatusGroup[], taskId: string, step: -1 | 1): StatusGroup | undefined {
    const index = columns.findIndex(column => column.tasks.some(item => item.id === taskId));
    return index === -1 ? undefined : columns[index + step];
}

/** True when the dragged task can go to the column. A task cannot go to the column of its own status. */
export function acceptsDrop(canMove: boolean, dragging: Task | undefined, columnKey: string): boolean {
    return canMove && !!dragging && statusKey(dragging.status.name) !== columnKey;
}

/** The status that a group or a column shows in its status dot. */
export function groupStatus(group: Pick<StatusGroup, 'key' | 'name' | 'color' | 'category'>): TaskStatus {
    return { id: group.key, name: group.name, color: group.color, category: group.category };
}

/** The accessible name of a task row or card. */
export function taskLabel(task: Pick<Task, 'key' | 'title'>): string {
    return task.key ? `${task.key} ${task.title}` : task.title;
}

/** The repository for "Start in worktree": the last one in this project, else the first. */
export function targetRepo(repos: readonly string[], last: string): string | undefined {
    return repos.includes(last) ? last : repos[0];
}

/** The text that tells which settings a task manager needs. */
export function missingSettingsText(connection: Pick<ConnectionInfo, 'settings'>): string {
    return (
        connection.settings
            .filter(setting => setting.required)
            .map(setting => setting.label.toLowerCase())
            .join(' and ') || 'settings'
    );
}

/** The tooltip of the collection picker. */
export function collectionTitle(current: Pick<TaskCollection, 'name' | 'path'> | undefined): string {
    return current ? `Collection: ${current.path ? `${current.path} / ` : ''}${current.name}` : 'Collection';
}

/** The placeholder of the collection picker. Undefined collections are still in load. */
export function collectionPlaceholder(collections: readonly TaskCollection[] | undefined): string {
    return !collections ? 'Loading collections…' : collections.length === 0 ? 'No collections' : 'Select a collection';
}
