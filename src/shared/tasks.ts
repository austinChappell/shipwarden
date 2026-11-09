/** The types of the ShipWarden Task Protocol, version 3. See docs/task-plugin-protocol.md. */

export type StatusCategory = 'backlog' | 'todo' | 'in_progress' | 'done' | 'canceled';

export interface TaskStatus {
    id: string;
    name: string;
    color?: string;
    category: StatusCategory;
    /**
     * The position of the status in the tracker's workflow. A lower number comes first.
     * ShipWarden uses it only when the plugin does not support tasks/statusOrder.
     */
    order?: number;
}

export interface TaskPerson {
    name: string;
    avatarUrl?: string;
}

export interface Task {
    id: string;
    key?: string;
    title: string;
    url?: string;
    status: TaskStatus;
    assignees?: TaskPerson[];
    labels?: { name: string; color?: string }[];
    priority?: { name: string; level: number };
    updatedAt?: string;
    description?: string;
    fields?: Record<string, string | number | boolean | null>;
}

/**
 * A collection of tasks in the tracker, with one status workflow: a ClickUp list, a GitHub repository,
 * a Linear team or a Jira project. The task view shows one collection at a time.
 */
export interface TaskCollection {
    id: string;
    name: string;
    /** The location of the collection, for example "Engineering / Sprints" for a ClickUp list, or the owner of a GitHub repository. */
    path?: string;
    url?: string;
    /** True for the collection that the plugin suggests first, for example the GitHub repository of the worktree. */
    default?: boolean;
}

/** The result of the tasks/statusOrder adapter: the workflow order of the statuses of one collection. */
export interface StatusOrder {
    statuses: TaskStatus[];
}

export interface TaskComment {
    id: string;
    author?: TaskPerson;
    body: string;
    createdAt?: string;
}

export interface FieldDefinition {
    id: string;
    label: string;
    type: 'text' | 'number' | 'date' | 'url' | 'boolean';
}

export interface ActionDefinition {
    id: string;
    label: string;
    confirm?: string;
}

export interface FilterDefinition {
    id: string;
    label: string;
    default?: boolean;
}

export interface SettingDefinition {
    key: string;
    label: string;
    type: 'string' | 'secret' | 'boolean';
    required?: boolean;
    description?: string;
}

/** A task plugin that ShipWarden found on disk: a kind of task manager, for example ClickUp. */
export interface PluginInfo {
    id: string;
    name: string;
    version: string;
    description?: string;
    settings: SettingDefinition[];
    builtIn: boolean;
    /** The word for a scope of this tracker in the UI, for example "workspace" or "organization". */
    scopeLabel?: string;
}

/**
 * A configured task manager: a plugin with its own settings (for example a ClickUp API token) and an optional scope.
 * A user can have several connections of one plugin, for example two ClickUp accounts.
 */
export interface TaskConnection {
    id: string;
    pluginId: string;
    /** The name in the UI, for example "ClickUp (Work)". */
    name: string;
    /** The scopes to include, for example ClickUp workspace IDs or GitHub organizations. Undefined means all. */
    scope?: string[];
    /** False when the connection is configured but off. An off connection is not in the Tasks view. */
    enabled: boolean;
    /**
     * The name of the status that a task gets when a worktree starts from it, for example "in progress".
     * ShipWarden finds it in the statuses of the task, without case. A task without such a status keeps its status.
     */
    startStatus?: string;
}

/** The changes of a connection that the settings page sends. Null removes the scope or the start status. */
export interface ConnectionChange {
    name?: string;
    scope?: string[] | null;
    enabled?: boolean;
    startStatus?: string | null;
}

/** Returns the status of a task with the name of the start status, without case. Undefined when the task has no such status. */
export function findStartStatus(statuses: readonly TaskStatus[], wanted: string | undefined): TaskStatus | undefined {
    const name = wanted?.trim().toLowerCase();
    return name ? statuses.find(status => status.name.trim().toLowerCase() === name) : undefined;
}

/** A connection with the state of its settings, for the settings page and the Tasks view. */
export interface ConnectionInfo extends TaskConnection {
    pluginName: string;
    scopeLabel?: string;
    settings: SettingDefinition[];
    /** True when each required setting has a value. */
    configured: boolean;
    /** The keys of the settings that have a value. ShipWarden does not send secret values to the UI. */
    settingsWithValue: string[];
    /** The values of the settings that are not secret. */
    publicSettings: Record<string, string | boolean>;
}

/** The task manager settings. All projects use the same connections. */
export interface TaskConfig {
    connections: TaskConnection[];
}

/** A scope that a connection can include, for example a ClickUp workspace or a GitHub organization. */
export interface TaskScope {
    id: string;
    name: string;
    /** A short note, for example "your account" for a GitHub user. */
    detail?: string;
}

function stringList(value: unknown): string[] | undefined {
    return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))] : undefined;
}

/**
 * Converts stored JSON to a valid configuration. Connections without a plugin are removed.
 * Files from before can have project overrides. Projects now use the global connections, so they are ignored.
 */
export function normalizeTaskConfig(value: unknown): TaskConfig {
    const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const connections: TaskConnection[] = [];
    for (const item of Array.isArray(raw.connections) ? raw.connections : []) {
        const connection = item as Record<string, unknown> | null;
        if (!connection || typeof connection.id !== 'string' || typeof connection.pluginId !== 'string' || connections.some(existing => existing.id === connection.id)) {
            continue;
        }
        connections.push({
            id: connection.id,
            pluginId: connection.pluginId,
            name: typeof connection.name === 'string' && connection.name.trim() ? connection.name.trim() : connection.pluginId,
            scope: stringList(connection.scope),
            enabled: connection.enabled !== false,
            ...(typeof connection.startStatus === 'string' && connection.startStatus.trim() ? { startStatus: connection.startStatus.trim() } : {})
        });
    }
    return { connections };
}

/** A connection after its plugin starts, for one project. */
export interface TaskSource {
    connectionId: string;
    pluginId: string;
    name: string;
    capabilities: {
        update?: boolean;
        /** "tasks/create": the view shows a button that makes a task. */
        create?: boolean;
        /** "tasks/update" also changes the title and the description. */
        edit?: boolean;
        /** "tasks/delete": the view shows a button that deletes a task. */
        delete?: boolean;
        statuses?: boolean;
        statusOrder?: boolean;
        comments?: boolean;
        actions?: boolean;
        scopes?: boolean;
        activity?: boolean;
    };
    fields: FieldDefinition[];
    actions: ActionDefinition[];
    filters: FilterDefinition[];
}

/** The task that a worktree works on. */
export interface TaskLink {
    /** The connection of the task. Links from before connections have only `pluginId`, which is also the ID of the migrated connection. */
    connectionId?: string;
    pluginId: string;
    taskId: string;
    key?: string;
    title: string;
    url?: string;
}

/** The order of the status groups in the task list. Active work comes first. */
export const STATUS_CATEGORY_ORDER: StatusCategory[] = ['in_progress', 'todo', 'backlog', 'done', 'canceled'];

export const STATUS_CATEGORY_LABELS: Record<StatusCategory, string> = {
    in_progress: 'In progress',
    todo: 'To do',
    backlog: 'Backlog',
    done: 'Done',
    canceled: 'Canceled'
};

function slug(text: string): string {
    return text
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Makes a branch name for a task, for example "abc-1684-fix-the-login-page" or "issue-42-add-dark-mode".
 * The name has at most `maxLength` characters and does not end in a hyphen.
 */
export function branchNameForTask(task: Pick<Task, 'key' | 'id' | 'title'>, maxLength = 60): string {
    const key = task.key?.startsWith('#') ? `issue-${task.key.slice(1)}` : task.key ?? '';
    const prefix = slug(key);
    const title = slug(task.title);
    const name = [prefix, title].filter(Boolean).join('-') || slug(task.id) || 'task';
    return name.slice(0, maxLength).replace(/-+$/, '');
}

/** Makes the prompt that starts an agent on a task. */
export function taskPrompt(task: Task, branch: string): string {
    const heading = task.key ? `${task.key}: ${task.title}` : task.title;
    const parts = [
        'Work on this task.',
        '',
        heading,
        task.url ?? '',
        '',
        task.description?.trim() || '(The task has no description.)',
        '',
        `You are in a new git worktree on the branch "${branch}". Make the change, run the tests and commit your work.`
    ];
    return parts.filter((part, index) => part !== '' || parts[index - 1] !== '').join('\n');
}

/** A group of tasks with the same status name. */
export interface StatusGroup {
    /** The status name in lowercase. It identifies the group, for example to remember that it is collapsed. */
    key: string;
    name: string;
    color?: string;
    category: StatusCategory;
    tasks: Task[];
}

/** Compares two positions. Infinity minus Infinity is NaN, so a subtraction does not work for two unknown statuses. */
function compareRanks(a: number, b: number): number {
    return a === b ? 0 : a < b ? -1 : 1;
}

/** Returns the group key of a status: its name in lowercase, without spaces at the ends. */
export function statusKey(name: string): string {
    return name.trim().toLowerCase();
}

/**
 * Groups tasks by the tracker's own status, for example "in review" and "in development".
 * Tasks from different lists can have statuses with the same name. These go in one group.
 *
 * With `statusOrder` (from the plugin's tasks/statusOrder adapter), the groups are in that order.
 * A status that is not in `statusOrder` comes after the others.
 * Without `statusOrder`, the groups are in STATUS_CATEGORY_ORDER, then in each status's `order`, then by name.
 */
export function groupTasksByStatus(tasks: readonly Task[], statusOrder?: readonly TaskStatus[]): StatusGroup[] {
    const position = new Map((statusOrder ?? []).map((status, index) => [statusKey(status.name), index]));
    const rank = (key: string) => position.get(key) ?? Number.POSITIVE_INFINITY;
    const groups = new Map<string, StatusGroup & { order: number }>();
    for (const task of tasks) {
        const key = statusKey(task.status.name);
        let group = groups.get(key);
        if (!group) {
            group = { key, name: task.status.name, color: task.status.color, category: task.status.category, tasks: [], order: Number.POSITIVE_INFINITY };
            groups.set(key, group);
        }
        group.tasks.push(task);
        if (task.status.order !== undefined) {
            group.order = Math.min(group.order, task.status.order);
        }
    }
    return [...groups.values()]
        .sort((a, b) =>
            compareRanks(rank(a.key), rank(b.key))
            || STATUS_CATEGORY_ORDER.indexOf(a.category) - STATUS_CATEGORY_ORDER.indexOf(b.category)
            || a.order - b.order
            || a.name.localeCompare(b.name))
        .map(({ order: _order, ...group }) => group);
}

/**
 * Returns the columns of a board: one column for each status of the collection's workflow, also without tasks,
 * so that a card can move to it. A status that a task has but the workflow does not have also gets a column.
 */
export function boardColumns(tasks: readonly Task[], statusOrder?: readonly TaskStatus[]): StatusGroup[] {
    const columns = groupTasksByStatus(tasks, statusOrder);
    const present = new Set(columns.map(column => column.key));
    const empty = (statusOrder ?? [])
        .filter(status => !present.has(statusKey(status.name)))
        .map(status => ({ key: statusKey(status.name), name: status.name, color: status.color, category: status.category, tasks: [] as Task[] }));
    if (empty.length === 0) {
        return columns;
    }
    // Sort again, so the empty columns go in their workflow position.
    const position = new Map((statusOrder ?? []).map((status, index) => [statusKey(status.name), index]));
    const unique = new Map([...columns, ...empty].map(column => [column.key, column]));
    return [...unique.values()].sort((a, b) => compareRanks(position.get(a.key) ?? Number.POSITIVE_INFINITY, position.get(b.key) ?? Number.POSITIVE_INFINITY));
}

/** Finds the status of a task's workflow that has the name of a board column. */
export function statusForColumn(columnKey: string, options: readonly TaskStatus[]): TaskStatus | undefined {
    return options.find(status => statusKey(status.name) === columnKey);
}

/**
 * Sorts collections for the picker: the collections without a path first, then by path and by name.
 * The path and the name compare separately, because collation ignores control characters in one joined string.
 */
export function sortCollections<T extends TaskCollection>(collections: readonly T[]): T[] {
    return [...collections].sort((a, b) =>
        (a.path ? 1 : 0) - (b.path ? 1 : 0)
        || (a.path ?? '').localeCompare(b.path ?? '', undefined, { sensitivity: 'base' })
        || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Selects the collection to show: the saved choice if it still exists, else the plugin's default, else the first collection. */
export function pickCollection(collections: readonly TaskCollection[], saved: string | undefined): string | undefined {
    if (saved && collections.some(collection => collection.id === saved)) {
        return saved;
    }
    return (collections.find(collection => collection.default) ?? collections[0])?.id;
}

/** Done and canceled groups start collapsed, so that the open work is visible first. */
export function collapsedByDefault(category: StatusCategory): boolean {
    return category === 'done' || category === 'canceled';
}

/** The result of `applyStartStatus`. "missing": the task has no status with that name, so it keeps its status. */
export type StartStatusResult = 'moved' | 'already' | 'missing' | 'unsupported' | 'none';

/**
 * Moves a task to the start status of its connection, when a worktree starts from it.
 * The statuses come from the task, because each ClickUp list can have its own statuses.
 * `request` sends a protocol request to the plugin of the connection.
 */
export async function applyStartStatus(
    task: Task,
    wanted: string | undefined,
    capabilities: { update?: boolean; statuses?: boolean },
    request: <T>(method: string, params: unknown) => Promise<T>
): Promise<StartStatusResult> {
    if (!wanted?.trim()) return 'none';
    if (!capabilities.update || !capabilities.statuses) return 'unsupported';
    const status = findStartStatus(await request<TaskStatus[]>('tasks/statuses', { id: task.id }), wanted);
    if (!status) return 'missing';
    if (status.id === task.status.id) return 'already';
    await request('tasks/update', { id: task.id, status: status.id });
    return 'moved';
}

/**
 * True when a worktree link belongs to a task of a connection. Links from older plugin versions can have another
 * form of the task ID (GitHub: "3" before "owner/repo#3"), so the URL of the task also matches.
 */
export function linkMatchesTask(link: TaskLink, connectionId: string | undefined, task: Pick<Task, 'id' | 'url'>): boolean {
    if ((link.connectionId ?? link.pluginId) !== connectionId) return false;
    return link.taskId === task.id || (!!link.url && link.url === task.url);
}

/** True when each word of the search text is in the task's key, title, labels or assignee names. The search is not case sensitive. */
export function taskMatches(task: Task, query: string): boolean {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const text = [task.key, task.title, ...(task.labels ?? []).map(label => label.name), ...(task.assignees ?? []).map(person => person.name)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    return words.every(word => text.includes(word));
}
