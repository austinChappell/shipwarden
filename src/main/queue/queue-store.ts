import { normalizeQueueState, type QueueState } from '@shared/task-queue';
import { JsonStore } from '../tasks/json-store';

/**
 * Keeps the task queue in one JSON file in the app data folder. The file keeps the order, the settings, and the state
 * of each item, so the queue continues after a restart of the app. The page runs the scheduler and saves each change.
 */
export class QueueStore {
    private readonly store: JsonStore<object>;

    constructor(file: string) {
        this.store = new JsonStore<object>(file, () => ({}));
    }

    async get(): Promise<QueueState> {
        return normalizeQueueState(await this.store.get());
    }

    /** Writes the queue and returns the saved copy. Items that are not valid go out. */
    async save(value: unknown): Promise<QueueState> {
        const state = normalizeQueueState(value);
        await this.store.update(() => state);
        return state;
    }
}
