import type { ChatChannel, ConnectionInfo, TaskSource } from '@shared/tasks';
import { taskQueryKeys } from '../components/tasks/task-view-logic';
import { connectionsQueryOptions } from '../components/tasks/use-task-source';
import { queryClient } from '../query-client';

const api = window.shipwarden.tasks;

/** The plugin keeps the channels for 10 minutes. The editor asks again after 5 minutes. */
const CHANNELS_STALE_MS = 5 * 60_000;
/** The capabilities of a connection change only when its settings change. */
const SOURCE_STALE_MS = 60_000;

/** The source of a connection. The Tasks view uses the same key, so a started source sends no new request. */
function fetchSource(connectionId: string): Promise<TaskSource> {
    return queryClient.fetchQuery<TaskSource>({
        queryKey: taskQueryKeys.source(connectionId),
        queryFn: () => api.source(connectionId),
        staleTime: SOURCE_STALE_MS
    });
}

/** The task managers that have chat channels. A connection that does not start does not show. */
export async function chatConnections(): Promise<ConnectionInfo[]> {
    const { list } = await queryClient.fetchQuery(connectionsQueryOptions());
    const sources = await Promise.all(list.map(connection => fetchSource(connection.id).catch(() => undefined)));
    return list.filter((_, index) => sources[index]?.capabilities.chat);
}

/** The query of the task managers that have chat channels. */
export function chatConnectionsQueryOptions() {
    return { queryKey: [...taskQueryKeys.connections(), 'chat'] as const, queryFn: chatConnections, staleTime: SOURCE_STALE_MS };
}

/** The query of the chat channels of a task manager. */
export function chatChannelsQueryOptions(connectionId: string | undefined) {
    return {
        queryKey: ['tasks', 'chatChannels', connectionId] as const,
        queryFn: async (): Promise<ChatChannel[]> => {
            const result = (await api.request(connectionId as string, 'chat/channels', {})) as { channels?: ChatChannel[] };
            return result.channels ?? [];
        },
        staleTime: CHANNELS_STALE_MS
    };
}

/**
 * Returns the connection of a "Post to a chat channel" action. An action without a connection (for example after an
 * import) uses the only task manager that has chat channels.
 */
export async function chatConnectionOf(connectionId: string | undefined): Promise<string> {
    if (connectionId) return connectionId;
    const connections = await chatConnections();
    if (connections.length === 1) return connections[0].id;
    throw new Error(
        connections.length === 0
            ? 'No task manager has chat channels. Add a ClickUp connection in Settings › Task managers.'
            : 'The action has no task manager. Select one in the editor.'
    );
}
