import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { ConnectionChange, ConnectionInfo, TaskSource } from '@shared/tasks';
import { keyRoots } from '../query-client';

/** The query keys of Settings › Task managers. The keys of the Tasks view are in `taskQueryKeys`. */
export const taskManagerKeys = {
    /** The task plugins that ShipWarden found. */
    plugins: [...keyRoots.tasks, 'plugins'] as const,
    /** All connections, also the connections that are off. */
    allConnections: [...keyRoots.tasks, 'allConnections'] as const,
    /** The scopes that a connection can include. */
    scopes: (connectionId: string) => [...keyRoots.tasks, 'scopes', connectionId] as const
};

/** The data of the query `taskQueryKeys.connections`: the connections that are on, and the selected connection of the project. */
interface ProjectConnections {
    list: ConnectionInfo[];
    saved: string | undefined;
}

/** The second parts of the Tasks view keys with the data of one connection. The third part is the connection ID. */
const CONNECTION_DATA_KINDS = ['source', 'collections', 'list', 'statusOrder', 'detail'];

/** The kinds of connection data that change when the plugin gets another scope or other settings. */
const TASK_DATA_KINDS = ['collections', 'list', 'statusOrder', 'detail'];

/** The connection with the change. The rules are the same as the rules of the main process. */
export function applyConnectionChange(connection: ConnectionInfo, change: ConnectionChange): ConnectionInfo {
    const next: ConnectionInfo = { ...connection };
    if (change.name?.trim()) next.name = change.name.trim();
    if (change.scope !== undefined) {
        if (change.scope) next.scope = change.scope;
        else delete next.scope;
    }
    if (change.enabled !== undefined) next.enabled = change.enabled;
    if (change.startStatus !== undefined) {
        const status = change.startStatus?.trim();
        if (status) next.startStatus = status;
        else delete next.startStatus;
    }
    return next;
}

/** The list with the change in the connection `id`. */
export function withConnectionChange(list: ConnectionInfo[], id: string, change: ConnectionChange): ConnectionInfo[] {
    return list.map(connection => (connection.id === id ? applyConnectionChange(connection, change) : connection));
}

/**
 * The connections that are on, after a change of the connection `id`. `all` is the list of all connections after the
 * change, when the cache has it. Returns undefined when the new list is not known: the change turns on a connection
 * that the list does not have.
 */
export function enabledAfterChange(
    enabled: ConnectionInfo[],
    all: ConnectionInfo[] | undefined,
    id: string,
    change: ConnectionChange
): ConnectionInfo[] | undefined {
    if (all) return all.filter(connection => connection.enabled);
    if (change.enabled === true && !enabled.some(connection => connection.id === id)) return undefined;
    return withConnectionChange(enabled, id, change).filter(connection => connection.enabled);
}

/** True when the query key holds data of the connection in the Tasks view. With `kinds`, only these kinds of data match. */
export function isConnectionDataKey(key: QueryKey, connectionId: string, kinds: readonly string[] = CONNECTION_DATA_KINDS): boolean {
    return key[0] === keyRoots.tasks[0] && kinds.includes(String(key[1])) && key[2] === connectionId;
}

/** The key prefix of the connection lists of all projects. */
const projectConnectionsRoot = [...keyRoots.tasks, 'connections'];

/**
 * Marks the task data of the connection as stale: the collections, the lists and the task details, and the task
 * activity of the Dashboard. Only the data that shows now loads again.
 */
function invalidateTaskData(client: QueryClient, connectionId: string): void {
    void client.invalidateQueries({ predicate: query => isConnectionDataKey(query.queryKey, connectionId, TASK_DATA_KINDS) }, { cancelRefetch: false });
    void client.invalidateQueries({ queryKey: [...keyRoots.dashboard, 'tasks'] }, { cancelRefetch: false });
}

/** Updates the cache after a new connection. A new connection has no settings, so it has no task data yet. */
export function connectionAdded(client: QueryClient, created: ConnectionInfo): void {
    const all = client.setQueryData<ConnectionInfo[]>(taskManagerKeys.allConnections, list => list && [...list, created]);
    if (all) {
        client.setQueriesData<ProjectConnections>({ queryKey: projectConnectionsRoot }, data => data && { ...data, list: all.filter(item => item.enabled) });
    } else {
        void client.invalidateQueries({ queryKey: projectConnectionsRoot });
    }
}

/**
 * Updates the cache after a change of a connection. The cache gets the change directly. A new scope or a new on/off
 * state changes the tasks of the connection, so only then the task data of the connection is stale.
 */
export function connectionChanged(client: QueryClient, id: string, change: ConnectionChange): void {
    const all = client.setQueryData<ConnectionInfo[]>(taskManagerKeys.allConnections, list => list && withConnectionChange(list, id, change));
    let unknown = false;
    client.setQueriesData<ProjectConnections>({ queryKey: projectConnectionsRoot }, data => {
        if (!data) return data;
        const list = enabledAfterChange(data.list, all, id, change);
        if (!list) {
            unknown = true;
            return data;
        }
        return { ...data, list };
    });
    if (unknown) void client.invalidateQueries({ queryKey: projectConnectionsRoot });
    const name = change.name?.trim();
    if (name) {
        client.setQueriesData<TaskSource>({ queryKey: [...keyRoots.tasks, 'source', id] }, source => source && { ...source, name });
    }
    if (change.scope !== undefined || change.enabled !== undefined) invalidateTaskData(client, id);
}

/**
 * Updates the cache after a save of the settings of a connection. The page does not know the new state of the secret
 * settings, so the connection lists load again. The plugin starts again with the new settings, so its scopes and its
 * task data are stale.
 */
export function connectionSettingsSaved(client: QueryClient, id: string): void {
    void client.invalidateQueries({ queryKey: taskManagerKeys.allConnections });
    void client.invalidateQueries({ queryKey: projectConnectionsRoot });
    void client.invalidateQueries({ queryKey: taskManagerKeys.scopes(id) });
    invalidateTaskData(client, id);
}

/** Updates the cache after the removal of a connection. The cache forgets all data of the connection. */
export function connectionRemoved(client: QueryClient, id: string): void {
    const without = (list: ConnectionInfo[]) => list.filter(connection => connection.id !== id);
    client.setQueryData<ConnectionInfo[]>(taskManagerKeys.allConnections, list => list && without(list));
    client.setQueriesData<ProjectConnections>({ queryKey: projectConnectionsRoot }, data => data && { ...data, list: without(data.list) });
    client.removeQueries({ predicate: query => isConnectionDataKey(query.queryKey, id) });
    client.removeQueries({ queryKey: taskManagerKeys.scopes(id) });
    void client.invalidateQueries({ queryKey: [...keyRoots.dashboard, 'tasks'] }, { cancelRefetch: false });
}
