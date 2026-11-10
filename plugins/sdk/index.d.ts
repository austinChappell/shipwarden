/** The types of the ShipWarden Task Protocol, version 3. See docs/task-plugin-protocol.md. */

export type StatusCategory = 'backlog' | 'todo' | 'in_progress' | 'done' | 'canceled';

export interface Status {
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

export interface Person {
    name: string;
    avatarUrl?: string;
}

export interface Label {
    name: string;
    color?: string;
}

export interface Task {
    id: string;
    key?: string;
    title: string;
    url?: string;
    status: Status;
    assignees?: Person[];
    labels?: Label[];
    priority?: { name: string; level: number };
    updatedAt?: string;
    description?: string;
    fields?: Record<string, string | number | boolean | null>;
}

/**
 * A collection of tasks with one status workflow: a ClickUp list, a GitHub repository, a Linear team or a Jira project.
 * The task view shows one collection at a time.
 */
export interface Collection {
    id: string;
    name: string;
    /** The location of the collection, for example "Engineering / Sprints" for a ClickUp list, or the owner of a GitHub repository. */
    path?: string;
    url?: string;
    /** True for the collection that the plugin suggests first, for example the GitHub repository of the worktree. */
    default?: boolean;
}

export interface Comment {
    id: string;
    author?: Person;
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

export interface Capabilities {
    update?: boolean;
    /** The plugin makes new tasks ("tasks/create"). */
    create?: boolean;
    /** "tasks/update" also changes the title and the description. The plugin sets this capability itself. */
    edit?: boolean;
    /** The plugin deletes tasks ("tasks/delete"). */
    delete?: boolean;
    statuses?: boolean;
    statusOrder?: boolean;
    comments?: boolean;
    actions?: boolean;
    scopes?: boolean;
    /** The plugin returns new comments from other people for the Dashboard ("activity/list"). */
    activity?: boolean;
}

/** A comment from another person on a task of the user, for the Dashboard. */
export interface ActivityComment {
    id: string;
    taskId: string;
    taskKey?: string;
    taskTitle: string;
    taskUrl?: string;
    author?: string;
    body: string;
    createdAt: string;
}

/** A scope that a connection can include, for example a ClickUp workspace or a GitHub organization. */
export interface Scope {
    id: string;
    name: string;
    detail?: string;
}

export interface InitializeParams {
    protocolVersion: 3;
    /** The settings of the connection (one configured task manager). */
    settings: Record<string, string | boolean>;
    /** The scope IDs that the connection includes in this project, for example ClickUp workspace IDs. Absent means all. */
    scope?: string[];
    /** The repositories of all ShipWarden projects. Empty when ShipWarden starts the plugin for the settings page. */
    context: { repositories: { root: string; github?: { owner: string; name: string } }[] };
}

export interface InitializeResult {
    name?: string;
    capabilities?: Capabilities;
    fields?: FieldDefinition[];
    actions?: ActionDefinition[];
    filters?: FilterDefinition[];
}

export interface Handlers {
    initialize(params: InitializeParams): Promise<InitializeResult>;
    /** Returns all scopes that the settings allow, also scopes outside `scope`. The settings page lists them. */
    listScopes?(params: Record<string, never>): Promise<Scope[]>;
    /** Returns the collections in the scope. Each task source must have collections. */
    listCollections(params: Record<string, never>): Promise<Collection[]>;
    listTasks(params: { collection: string; filter?: string; query?: string; cursor?: string }): Promise<{ tasks: Task[]; nextCursor?: string }>;
    getTask(params: { id: string }): Promise<Task>;
    /** Changes a task. `title` and `description` come only when the plugin has the capability "edit". */
    updateTask?(params: { id: string; status?: string; title?: string; description?: string }): Promise<Task>;
    /** Makes a task in a collection. Without `status`, the task gets the first status of the workflow. */
    createTask?(params: { collection: string; title: string; description?: string; status?: string }): Promise<Task>;
    /** Deletes a task. */
    deleteTask?(params: { id: string }): Promise<null>;
    listStatuses?(params: { id?: string }): Promise<Status[]>;
    /**
     * Returns all statuses of the collection's workflow, in order. The list groups and the board columns use this order,
     * and the board shows a column for each status, also without tasks.
     */
    statusOrder?(params: { collection: string }): Promise<{ statuses: Status[] }>;
    listComments?(params: { taskId: string }): Promise<Comment[]>;
    createComment?(params: { taskId: string; body: string }): Promise<Comment>;
    runAction?(params: { taskId: string; actionId: string }): Promise<{ message?: string }>;
    /**
     * Returns the comments from other people on the user's tasks that are newer than `since` (an ISO time).
     * A comment before the user's own last comment on the same task does not count, because the user saw it.
     */
    listActivity?(params: { since: string }): Promise<{ comments: ActivityComment[] }>;
}

export interface PluginConnection {
    notify(method: 'tasks/changed', params: { ids?: string[] }): void;
}

export function runPlugin(handlers: Handlers): PluginConnection;
export function log(...parts: unknown[]): void;
/** Describes a failed fetch, with the reason from `cause` and a hint for certificate errors. */
export function networkDetail(error: unknown): string;
export function createMessageParser(): (chunk: Buffer) => unknown[];
export function encodeMessage(message: unknown): string;
