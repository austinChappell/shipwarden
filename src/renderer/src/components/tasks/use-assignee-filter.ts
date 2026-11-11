import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ALL_ASSIGNEES, ME, type AssigneeFilter, type TaskPerson, type TaskSource } from '@shared/tasks';
import { taskQueryKeys } from './task-view-logic';
import type { TaskRequest } from './use-task-source';

/** The people of a collection change seldom. The list loads again after this time. */
export const PEOPLE_STALE_MS = 10 * 60 * 1000;

/** The last assignee filter of each connection, for the session. */
const lastFilters = new Map<string, AssigneeFilter>();

/** The first filter of a connection: the tasks of the user when the plugin knows the user, else all tasks. */
export function defaultAssigneeFilter(source: Pick<TaskSource, 'capabilities'> | null | undefined): AssigneeFilter {
    return source?.capabilities.assignees ? { people: [ME], unassigned: false } : ALL_ASSIGNEES;
}

interface Options {
    source: TaskSource | null | undefined;
    collection: string | undefined;
    request: TaskRequest;
}

/**
 * The assignee filter of the selected connection, and the people that the filter lists.
 * The view selects the tasks itself, so a change of the filter sends no request to the plugin.
 * A plugin with the capability "assignees" lists the people of the collection and tells which person is the user.
 * For other plugins, the filter lists the assignees of the loaded tasks.
 */
export function useAssigneeFilter({ source, collection, request }: Options) {
    const connectionId = source?.connectionId;
    const supported = !!source?.capabilities.assignees;
    // A change of the state renders the view again. The map keeps the filter of each connection.
    const [, setVersion] = useState(0);
    const filter = (connectionId && lastFilters.get(connectionId)) || defaultAssigneeFilter(source);

    const setFilter = (next: AssigneeFilter) => {
        if (!connectionId) return;
        lastFilters.set(connectionId, next);
        setVersion(version => version + 1);
    };

    const peopleQuery = useQuery({
        queryKey: taskQueryKeys.people(connectionId, collection),
        queryFn: () => request<{ people: TaskPerson[]; me?: string }>('people/list', { collection }),
        enabled: supported && !!collection,
        staleTime: PEOPLE_STALE_MS
    });
    const people = supported && collection ? peopleQuery.data : undefined;

    /**
     * True while the filter has "Me" and the view does not know the user yet. Then the view waits, so that the list
     * does not show all tasks or no tasks for a moment. After a failed load, "Me" finds no tasks.
     */
    const waitingForMe = supported && !!collection && filter.people.includes(ME) && peopleQuery.isPending;

    // `people` is the list of the plugin. The view adds the assignees of the loaded tasks.
    return { filter, setFilter, me: people?.me, supported, people: people?.people, waitingForMe };
}
