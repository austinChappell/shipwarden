import { normalizeQueueState, type QueueState } from '@shared/task-queue';
import { JsonStore } from '../tasks/json-store';

/**
 * Keeps the task queue in one JSON file in the app data folder. The file keeps the order, the settings, and the state
 * of each item, so the queue continues after a restart of the app. The page runs the scheduler and saves each change.
 * While the app is closed, the background helper can run the queue (`HeadlessQueue`) and change the file.
 */
export class QueueStore {
    private readonly store: JsonStore<object>;

    constructor(file: string) {
        this.store = new JsonStore<object>(file, () => ({}));
    }

    /** Reads the file again at the next call. The background helper can change it while it holds the engine lock. */
    reload(): Promise<void> {
        return this.store.reload();
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
