import type { ConnectionInfo, FilterDefinition, StatusGroup, Task, TaskCollection, TaskComment, TaskLink, TaskSource, TaskStatus } from '@shared/tasks';
import { linkMatchesTask, statusKey } from '@shared/tasks';
import { cacheKey } from '../../data-cache';

/** The list (grouped) or the board (a column for each status). */
export type ViewMode = 'list' | 'board';

/** The groups that the user opened or collapsed, by status key. Each plugin has its own record. */
export type CollapseState = Record<string, boolean>;

/** The state of the selected task manager. The plugin starts again only when this state changes. */
export type ConnectionState = 'loading' | 'none' | 'ready' | 'unconfigured';

/** The selected collection, with the connection that it belongs to. */
export interface CollectionSelection {
    connectionId: string;
    id: string;
}

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

/**
 * The cache keys of the view. The view shows cached data immediately and loads new data in the background.
 * Each key starts with the connection and the project, because the same connection can have other data in another project.
 */
export const connectionsKey = (projectId: string) => cacheKey('tasks.connections', projectId);
export const connectionIdKey = (projectId: string) => cacheKey('tasks.connectionId', projectId);
export const sourceKey = (connectionId: string, projectId: string) => cacheKey('tasks.source', connectionId, projectId);
export const filterKey = (connectionId: string, projectId: string) => cacheKey('tasks.filter', connectionId, projectId);
export const collectionsKey = (connectionId: string, projectId: string) => cacheKey('tasks.collections', connectionId, projectId);
export const selectionKey = (connectionId: string, projectId: string) => cacheKey('tasks.selection', connectionId, projectId);
export const tasksKey = (connectionId: string, projectId: string, collection: string, filter: string | undefined) =>
    cacheKey('tasks.list', connectionId, projectId, collection, filter);
export const statusOrderKey = (connectionId: string, projectId: string, collection: string) =>
    cacheKey('tasks.statusOrder', connectionId, projectId, collection);
export const detailKey = (connectionId: string, projectId: string, taskId: string) => cacheKey('tasks.detail', connectionId, projectId, taskId);

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

/** Returns the old value when the new value has the same data, so that effects that use the value do not run again. */
export function same<T>(current: T, next: T): T {
    return current !== undefined && JSON.stringify(current) === JSON.stringify(next) ? current : next;
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

/**
 * Returns the selected collection ID. During a switch to another connection, the old selection is still in state
 * for one render. It must not go to the new connection, so it counts only for its own connection.
 */
export function selectedCollection(
    source: Pick<TaskSource, 'connectionId'> | null | undefined,
    selection: CollectionSelection | undefined
): string | undefined {
    return source && selection?.connectionId === source.connectionId ? selection.id : undefined;
}

/** Returns the current selection when it is the same as the picked collection, so that effects do not run again. */
export function nextSelection(current: CollectionSelection | undefined, connectionId: string, picked: string | undefined): CollectionSelection | undefined {
    if (current?.connectionId === connectionId && current.id === picked) return current;
    return picked ? { connectionId, id: picked } : undefined;
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
