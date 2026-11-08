import { JsonStore } from './tasks/json-store';

/** The store keeps a seen item for this time. The Dashboard does not show older comments, so older records are not needed. */
const KEEP_MS = 60 * 24 * 3600 * 1000;

interface SeenFile {
    /** The time (milliseconds since 1970) that the user saw each item, by key, for example "gh:<node id>". */
    seen: Record<string, number>;
}

/** Keeps the record of the comments that the user saw in ShipWarden. Nothing goes to GitHub or ClickUp. */
export class SeenStore {
    private readonly store: JsonStore<SeenFile>;

    constructor(file: string) {
        this.store = new JsonStore<SeenFile>(file, () => ({ seen: {} }));
    }

    async keys(): Promise<string[]> {
        const value = await this.store.get();
        return Object.keys(value.seen ?? {});
    }

    /** Adds the keys to the record and removes records that are older than the keep time. */
    async mark(keys: string[]): Promise<void> {
        const fresh = keys.filter(key => typeof key === 'string' && key.length > 0 && key.length < 300);
        if (fresh.length === 0) {
            return;
        }
        const now = Date.now();
        await this.store.update(value => {
            const seen: Record<string, number> = {};
            for (const [key, at] of Object.entries(value.seen ?? {})) {
                if (typeof at === 'number' && now - at < KEEP_MS) {
                    seen[key] = at;
                }
            }
            for (const key of fresh) {
                seen[key] ??= now;
            }
            return { seen };
        });
    }
}
