import { useCallback, useEffect, useState } from 'react';
import { pickCollection, sortCollections, type ConnectionInfo, type TaskCollection, type TaskSource } from '@shared/tasks';
import { errorText } from '../../util';
import { cached, remember } from '../../data-cache';
import {
    collectionsKey,
    connectionIdKey,
    connectionsKey,
    connectionStateOf,
    filterKey,
    nextSelection,
    pickConnection,
    pickFilter,
    same,
    selectedCollection,
    selectionKey,
    sourceKey,
    type CollectionSelection
} from './task-view-logic';

const api = window.shipwarden.tasks;

/** A request to the plugin of the selected task manager. */
export type TaskRequest = <T>(method: string, params: unknown) => Promise<T>;

/**
 * The task managers of the project, the started plugin (the source), its filter and its collections.
 * `setSelectedId` clears the selected task when the source or the collection changes.
 * `setListError` shows an error when the collections do not load.
 */
export function useTaskSource(projectId: string, setSelectedId: (id: string | undefined) => void, setListError: (error: string | undefined) => void) {
    /** The task managers (connections) of the project. */
    const [connections, setConnections] = useState<ConnectionInfo[] | undefined>(() => cached(connectionsKey(projectId)));
    const [connectionId, setConnectionId] = useState<string | undefined>(() => cached(connectionIdKey(projectId)));
    const [sourceError, setSourceError] = useState<string>();
    const [filter, setFilter] = useState<string>();
    /** The collections of the task source, for example ClickUp lists or GitHub repositories. */
    const [collections, setCollections] = useState<TaskCollection[]>();
    /**
     * The selected collection, with the connection that it belongs to. During a switch to another connection, the old
     * collection is still in state for one render. It must not go to the new connection, so it counts only for its own.
     */
    const [selection, setSelection] = useState<CollectionSelection>();
    const [source, setSource] = useState<TaskSource | null>();
    const collection = selectedCollection(source, selection);
    /** Changes when the user asks to load the collections again, for example after a failed request. */
    const [collectionsReload, setCollectionsReload] = useState(0);

    const request: TaskRequest = useCallback(
        <T>(method: string, params: unknown) => {
            if (!connectionId) {
                return Promise.reject(new Error('Select a task manager.'));
            }
            return api.request(connectionId, projectId, method, params) as Promise<T>;
        },
        [connectionId, projectId]
    );

    // Load the task managers of the project, and select the last one that the user showed in this project.
    useEffect(() => {
        let cancelled = false;
        setConnections(cached(connectionsKey(projectId)));
        setConnectionId(cached(connectionIdKey(projectId)));
        Promise.all([api.enabledConnections(), api.selectedConnection(projectId).catch(() => undefined)]).then(
            ([list, saved]) => {
                if (cancelled) return;
                setConnections(current => same(current, remember(connectionsKey(projectId), list)));
                setConnectionId(remember(connectionIdKey(projectId), pickConnection(list, saved)));
            },
            err => {
                if (!cancelled) {
                    setConnections([]);
                    setSourceError(errorText(err));
                }
            }
        );
        return () => {
            cancelled = true;
        };
        // The view opens again after a visit to Settings, so it loads the task managers again then.
    }, [projectId]);

    const connectionState = connectionStateOf(connections, connectionId);

    // Start the plugin of the selected task manager. The cached source shows immediately while the plugin starts.
    useEffect(() => {
        let cancelled = false;
        setSourceError(undefined);
        setSelectedId(undefined);
        if (connectionState !== 'ready' || !connectionId) {
            setSource(connectionState === 'loading' ? undefined : null);
            return;
        }
        const lastFilter = () => cached<string>(filterKey(connectionId, projectId));
        const last = cached<TaskSource>(sourceKey(connectionId, projectId));
        setSource(last);
        if (last) setFilter(pickFilter(last.filters, lastFilter()));
        api.source(connectionId, projectId).then(
            started => {
                if (cancelled) return;
                remember(sourceKey(connectionId, projectId), started);
                setSource(current => same(current, started));
                setFilter(pickFilter(started.filters, lastFilter()));
            },
            err => {
                if (!cancelled) {
                    setSourceError(errorText(err));
                    setSource(null);
                }
            }
        );
        return () => {
            cancelled = true;
        };
    }, [connectionState, connectionId, projectId]);

    // Keep the filter of each source for the next visit.
    useEffect(() => {
        if (source && filter) remember(filterKey(source.connectionId, projectId), filter);
    }, [source, filter, projectId]);

    const selectConnection = (id: string) => {
        setConnectionId(remember(connectionIdKey(projectId), id));
        api.setSelectedConnection(projectId, id).catch(() => undefined);
    };

    // Load the collections of the source and select the saved one, the plugin's default or the first one.
    const sourceConnection = source?.connectionId;
    useEffect(() => {
        // After a switch, the old source is still in state for one render. Load only for the selected connection.
        if (!sourceConnection || sourceConnection !== connectionId) {
            setCollections(undefined);
            setSelection(undefined);
            return;
        }
        // The cached collections and selection show immediately while the new ones load.
        const lastSelection = cached<string>(selectionKey(sourceConnection, projectId));
        setCollections(cached(collectionsKey(sourceConnection, projectId)));
        setSelection(lastSelection ? { connectionId: sourceConnection, id: lastSelection } : undefined);
        let cancelled = false;
        Promise.all([request<TaskCollection[]>('collections/list', {}), api.selectedCollection(sourceConnection).catch(() => undefined)]).then(
            ([list, saved]) => {
                if (cancelled) return;
                const sorted = remember(collectionsKey(sourceConnection, projectId), sortCollections(list));
                setCollections(current => same(current, sorted));
                const picked = pickCollection(sorted, saved);
                if (picked) remember(selectionKey(sourceConnection, projectId), picked);
                setSelection(current => nextSelection(current, sourceConnection, picked));
            },
            err => {
                if (!cancelled) {
                    setCollections([]);
                    setListError(errorText(err));
                }
            }
        );
        return () => {
            cancelled = true;
        };
    }, [sourceConnection, connectionId, projectId, request, collectionsReload]);

    /** Selects a collection. The main process remembers it for the task source, in all repositories and after a restart. */
    const selectCollection = (id: string) => {
        if (source) {
            setSelection({ connectionId: source.connectionId, id });
            remember(selectionKey(source.connectionId, projectId), id);
        }
        setSelectedId(undefined);
        if (source) {
            api.setSelectedCollection(source.connectionId, id).catch(() => undefined);
        }
    };

    /** Asks for the collections again, for example after a failed request. */
    const reloadCollections = () => setCollectionsReload(key => key + 1);

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
        selectCollection,
        reloadCollections,
        request
    };
}
