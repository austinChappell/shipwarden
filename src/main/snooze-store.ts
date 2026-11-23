import { isSnooze, isSnoozeOld, type Snooze, type Snoozes } from '@shared/snooze';
import { JsonStore } from './tasks/json-store';

interface SnoozeFile {
    /** The snoozes by key, for example "pr:<url>". */
    snoozes: Snoozes;
}

/** Keeps the snoozes of pull requests. Nothing goes to the code review provider. */
export class SnoozeStore {
    private readonly store: JsonStore<SnoozeFile>;

    constructor(file: string) {
        this.store = new JsonStore<SnoozeFile>(file, () => ({ snoozes: {} }));
    }

    /** Returns the snoozes that did not end. */
    async list(now = Date.now()): Promise<Snoozes> {
        const value = await this.store.get();
        return keep(value.snoozes, now);
    }

    /** Sets the snooze of the key. Null removes it. The write also removes the snoozes that ended. */
    async set(key: string, snooze: Snooze | null, now = Date.now()): Promise<void> {
        if (typeof key !== 'string' || key.length === 0 || key.length > 500) return;
        if (snooze !== null && !isSnooze(snooze)) return;
        await this.store.update(value => {
            const snoozes = keep(value.snoozes, now);
            if (snooze) snoozes[key] = snooze;
            else delete snoozes[key];
            return { snoozes };
        });
    }
}

/** Returns a copy without the snoozes that ended or that are too old, and without bad records. */
function keep(snoozes: Snoozes | undefined, now: number): Snoozes {
    const result: Snoozes = {};
    for (const [key, snooze] of Object.entries(snoozes ?? {})) {
        if (isSnooze(snooze) && !isSnoozeOld(snooze, now)) result[key] = snooze;
    }
    return result;
}
