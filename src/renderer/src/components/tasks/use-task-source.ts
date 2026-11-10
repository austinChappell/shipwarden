import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pickCollection, sortCollections, taskProjectKey, type ConnectionInfo, type TaskCollection, type TaskSource } from '@shared/tasks';
import { optionalErrorText } from '../../util';
import { connectionStateOf, lastFilter, pickConnection, pickFilter, rememberFilter, taskQueryKeys } from './task-view-logic';

const api = window.shipwarden.tasks;

/** A request to the plugin of the selected task manager. */
export type TaskRequest = <T>(method: string, params: unknown) => Promise<T>;

/** The task managers of the project, and the task manager that the user selected last in the project. */
interface ConnectionsData {
    list: ConnectionInfo[];
    saved: string | undefined;
}

/** The sorted collections of a source, and the collection that the user selected last for the source. */
interface CollectionsData {
    list: TaskCollection[];
    saved: string | undefined;
}

/**
 * The task managers of the project, the started plugin (the source), its filter and its collections.
 * The query cache keeps each of them. Cached data shows in the first render, while new data loads in the background.
 * `setSelectedId` clears the selected task when the user selects another connection or collection.
 */
export function useTaskSource(projectId: string, setSelectedId: (id: string | undefined) => void) {
    const queryClient = useQueryClient();

    // The task managers change in Settings. Thus they load again each time that the view opens.
    const connectionsQuery = useQuery({
        queryKey: taskQueryKeys.connections(projectId),
        queryFn: async (): Promise<ConnectionsData> => {
            const [list, saved] = await Promise.all([api.enabledConnections(), api.selectedConnection(projectId).catch(() => undefined)]);
            return { list, saved };
        },
        staleTime: 0
    });
    const connections = connectionsQuery.data?.list ?? (connectionsQuery.isError ? [] : undefined);
    const connectionId = connectionsQuery.data ? pickConnection(connectionsQuery.data.list, connectionsQuery.data.saved) : undefined;
    const connectionState = connectionStateOf(connections, connectionId);
    /** The project key of the task data. All projects share the cached data of a plugin without project context. */
    const projectKey = taskProjectKey(
        connections?.find(item => item.id === connectionId),
        projectId
    );

    const request: TaskRequest = useCallback(
        <T>(method: string, params: unknown) => {
            if (!connectionId) {
                return Promise.reject(new Error('Select a task manager.'));
            }
            return api.request(connectionId, projectId, method, params) as Promise<T>;
        },
        [connectionId, projectId]
    );

    // Start the plugin of the selected task manager. The settings of a plugin can change, so it starts again each time that the view opens.
    const sourceQuery = useQuery({
        queryKey: taskQueryKeys.source(connectionId, projectKey),
        queryFn: () => api.source(connectionId as string, projectId),
        enabled: connectionState === 'ready' && !!connectionId,
        staleTime: 0
    });
    /** undefined: the source loads. null: no source, or the source did not start. */
    const source: TaskSource | null | undefined =
        connectionState === 'loading' ? undefined : connectionState !== 'ready' || sourceQuery.isError ? null : sourceQuery.data;
    const sourceError = optionalErrorText(connectionsQuery.error ?? (connectionState === 'ready' ? sourceQuery.error : null));
    /** The source of the selected connection. After a switch, the cached source of the old connection must not show. */
    const readySource = source && source.connectionId === connectionId ? source : undefined;

    /** The filter that the user selected in this view. Else the view uses the last filter of the source, or its default filter. */
    const [chosenFilter, setChosenFilter] = useState<{ connectionId: string; id: string }>();
    const filter = readySource
        ? pickFilter(
              readySource.filters,
              chosenFilter?.connectionId === readySource.connectionId ? chosenFilter.id : lastFilter(readySource.connectionId, projectId)
          )
        : undefined;
    const setFilter = (id: string) => {
        if (!readySource) return;
        rememberFilter(readySource.connectionId, projectId, id);
        setChosenFilter({ connectionId: readySource.connectionId, id });
    };

    const selectConnection = (id: string) => {
        queryClient.setQueryData<ConnectionsData>(taskQueryKeys.connections(projectId), data => data && { ...data, saved: id });
        setSelectedId(undefined);
        api.setSelectedConnection(projectId, id).catch(() => undefined);
    };

    // Load the collections of the source. The view selects the saved one, the plugin's default or the first one.
    const collectionsQuery = useQuery({
        queryKey: taskQueryKeys.collections(readySource?.connectionId, projectKey),
        queryFn: async (): Promise<CollectionsData> => {
            const sourceConnection = readySource?.connectionId as string;
            const [list, saved] = await Promise.all([
                request<TaskCollection[]>('collections/list', {}),
                api.selectedCollection(sourceConnection).catch(() => undefined)
            ]);
            return { list: sortCollections(list), saved };
        },
        enabled: !!readySource
    });
    const collections = readySource ? (collectionsQuery.data?.list ?? (collectionsQuery.isError ? [] : undefined)) : undefined;
    const collection = readySource && collectionsQuery.data ? pickCollection(collectionsQuery.data.list, collectionsQuery.data.saved) : undefined;
    const collectionsError = readySource ? optionalErrorText(collectionsQuery.error) : undefined;

    /** Selects a collection. The main process remembers it for the task source, in all repositories and after a restart. */
    const selectCollection = (id: string) => {
        setSelectedId(undefined);
        if (!readySource) return;
        queryClient.setQueryData<CollectionsData>(taskQueryKeys.collections(readySource.connectionId, projectKey), data => data && { ...data, saved: id });
        api.setSelectedCollection(readySource.connectionId, id).catch(() => undefined);
    };

    /** Asks for the collections again, for example after a failed request. */
    const reloadCollections = () => void collectionsQuery.refetch();

    return {
        connections,
        connectionId,
        connectionState,
        projectKey,
        selectConnection,
        source,
        sourceError,
        filter,
        setFilter,
        collections,
        collection,
        collectionsError,
        selectCollection,
        reloadCollections,
        request
    };
}
