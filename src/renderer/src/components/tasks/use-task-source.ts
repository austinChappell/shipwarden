import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pickCollection, sortCollections, type ConnectionInfo, type TaskCollection, type TaskSource } from '@shared/tasks';
import { optionalErrorText } from '../../util';
import { connectionStateOf, lastFilter, pickConnection, pickFilter, rememberFilter, taskQueryKeys } from './task-view-logic';

const api = window.shipwarden.tasks;

/** A request to the plugin of the selected task manager. */
export type TaskRequest = <T>(method: string, params: unknown) => Promise<T>;

/** The task managers, and the task manager that the user selected last. */
export interface ConnectionsData {
    list: ConnectionInfo[];
    saved: string | undefined;
}

/** The query of the task managers that are on. The Tasks view and the automation editor share it. */
export function connectionsQueryOptions() {
    return {
        queryKey: taskQueryKeys.connections(),
        queryFn: async (): Promise<ConnectionsData> => {
            const [list, saved] = await Promise.all([api.enabledConnections(), api.selectedConnection().catch(() => undefined)]);
            return { list, saved };
        },
        // The task managers change in Settings. Thus they load again each time that a view opens.
        staleTime: 0
    };
}

/** The query of the collections of a task manager. The Tasks view and the automation editor share it. */
export function collectionsQueryOptions(connectionId: string | undefined) {
    return {
        queryKey: taskQueryKeys.collections(connectionId),
        queryFn: async (): Promise<CollectionsData> => {
            const id = connectionId as string;
            const [list, saved] = await Promise.all([
                api.request(id, 'collections/list', {}) as Promise<TaskCollection[]>,
                api.selectedCollection(id).catch(() => undefined)
            ]);
            return { list: sortCollections(list), saved };
        }
    };
}

/** The sorted collections of a source, and the collection that the user selected last for the source. */
export interface CollectionsData {
    list: TaskCollection[];
    saved: string | undefined;
}

/**
 * The task managers, the started plugin (the source), its filter and its collections. All projects use the same data.
 * The query cache keeps each of them. Cached data shows in the first render, while new data loads in the background.
 * `setSelectedId` clears the selected task when the user selects another connection or collection.
 */
export function useTaskSource(setSelectedId: (id: string | undefined) => void) {
    const queryClient = useQueryClient();

    const connectionsQuery = useQuery(connectionsQueryOptions());
    const connections = connectionsQuery.data?.list ?? (connectionsQuery.isError ? [] : undefined);
    const connectionId = connectionsQuery.data ? pickConnection(connectionsQuery.data.list, connectionsQuery.data.saved) : undefined;
    const connectionState = connectionStateOf(connections, connectionId);

    const request: TaskRequest = useCallback(
        <T>(method: string, params: unknown) => {
            if (!connectionId) {
                return Promise.reject(new Error('Select a task manager.'));
            }
            return api.request(connectionId, method, params) as Promise<T>;
        },
        [connectionId]
    );

    // Start the plugin of the selected task manager. The settings of a plugin can change, so it starts again each time that the view opens.
    const sourceQuery = useQuery({
        queryKey: taskQueryKeys.source(connectionId),
        queryFn: () => api.source(connectionId as string),
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
        ? pickFilter(readySource.filters, chosenFilter?.connectionId === readySource.connectionId ? chosenFilter.id : lastFilter(readySource.connectionId))
        : undefined;
    const setFilter = (id: string) => {
        if (!readySource) return;
        rememberFilter(readySource.connectionId, id);
        setChosenFilter({ connectionId: readySource.connectionId, id });
    };

    const selectConnection = (id: string) => {
        queryClient.setQueryData<ConnectionsData>(taskQueryKeys.connections(), data => data && { ...data, saved: id });
        setSelectedId(undefined);
        api.setSelectedConnection(id).catch(() => undefined);
    };

    // Load the collections of the source. The view selects the saved one, the plugin's default or the first one.
    const collectionsQuery = useQuery({ ...collectionsQueryOptions(readySource?.connectionId), enabled: !!readySource });
    const collections = readySource ? (collectionsQuery.data?.list ?? (collectionsQuery.isError ? [] : undefined)) : undefined;
    const collection =
        readySource && collectionsQuery.data
            ? pickCollection(collectionsQuery.data.list, collectionsQuery.data.saved, readySource.capabilities.defaultCollectionOnly)
            : undefined;
    const collectionsError = readySource ? optionalErrorText(collectionsQuery.error) : undefined;

    /** Selects a collection. The main process remembers it for the task source, in all repositories and after a restart. */
    const selectCollection = (id: string) => {
        setSelectedId(undefined);
        if (!readySource) return;
        queryClient.setQueryData<CollectionsData>(taskQueryKeys.collections(readySource.connectionId), data => data && { ...data, saved: id });
        api.setSelectedCollection(readySource.connectionId, id).catch(() => undefined);
    };

    /** Asks for the collections again, for example after a failed request. */
    const reloadCollections = () => void collectionsQuery.refetch();

    return {
        connections,
        connectionId,
        connectionState,
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
