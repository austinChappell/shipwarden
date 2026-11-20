import { useQuery } from '@tanstack/react-query';
import { addToQueue, EMPTY_QUEUE, newQueueItemId, type QueueInput, type QueueItem, type QueueState } from '@shared/task-queue';
import { keyRoots, queryClient } from '../query-client';

const api = window.shipwarden;

/** The query of the task queue. The data is local. Each change patches the cache, so the queue never loads again. */
export const queueQuery = {
    queryKey: keyRoots.queue,
    queryFn: () => api.queue.get(),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false as const
};

/** The task queue, and true when it loaded. */
export function useTaskQueue(): { state: QueueState; loaded: boolean } {
    const query = useQuery(queueQuery);
    return { state: query.data ?? EMPTY_QUEUE, loaded: query.isSuccess };
}

/** The queue from the cache. */
export function cachedQueue(): QueueState {
    return queryClient.getQueryData<QueueState>(keyRoots.queue) ?? EMPTY_QUEUE;
}

/**
 * Changes the queue with a pure function of `@shared/task-queue`, and saves the result. The cache changes at once, in
 * the same step as the read. Thus two changes at the same time do not lose one of them. The saves reach the main
 * process in the same order.
 */
export async function changeQueue(change: (state: QueueState) => QueueState): Promise<QueueState> {
    await queryClient.ensureQueryData(queueQuery);
    const before = cachedQueue();
    const next = change(before);
    if (next === before) return before;
    queryClient.setQueryData<QueueState>(keyRoots.queue, next);
    await api.queue.save(next);
    return next;
}

/** Adds a task to the end of the queue. Returns the item, and false when the task was in the queue already. */
export async function queueTask(input: QueueInput): Promise<{ item: QueueItem; added: boolean }> {
    let result: { item: QueueItem; added: boolean } | undefined;
    await changeQueue(state => {
        const now = Date.now();
        const added = addToQueue(state, input, newQueueItemId(now), now);
        result = { item: added.item, added: added.added };
        return added.state;
    });
    if (!result) throw new Error('The task did not go into the queue.');
    return result;
}
