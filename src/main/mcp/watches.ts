import { randomUUID } from 'crypto';
import { WATCH_EVENTS, type McpWatch, type WatchEvent } from '@shared/mcp';
import { JsonStore } from '../tasks/json-store';

/** Returns the known watch events of a value, without duplicates. A wrong value or an empty list gives all events. */
export function watchEventsOf(value: unknown): WatchEvent[] {
    const list = Array.isArray(value) ? value.filter((item): item is WatchEvent => (WATCH_EVENTS as readonly unknown[]).includes(item)) : [];
    return list.length > 0 ? WATCH_EVENTS.filter(event => list.includes(event)) : [...WATCH_EVENTS];
}

/** Returns the valid watches of a value. A wrong value gives an empty list. */
export function normalizeWatches(value: unknown): McpWatch[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
        const watch = item as Partial<McpWatch> | null;
        if (!watch || typeof watch.id !== 'string' || typeof watch.worktree !== 'string' || typeof watch.sessionId !== 'string') return [];
        if (typeof watch.number !== 'number' || typeof watch.createdAt !== 'number') return [];
        return [{ ...watch, events: watchEventsOf(watch.events) } as McpWatch];
    });
}

/**
 * The watches of watch_pull_request, in a file of the app data folder. The agents stay alive in the PTY host when the
 * app closes, so the watches stay too. A session has one watch for each worktree. A new watch replaces the old one.
 */
export class McpWatches {
    private readonly store: JsonStore<{ watches?: McpWatch[] }>;

    constructor(
        file: string,
        private readonly onChanged: (watches: McpWatch[]) => void = () => undefined,
        private readonly now: () => number = Date.now
    ) {
        this.store = new JsonStore(file, () => ({}));
    }

    async list(): Promise<McpWatch[]> {
        return normalizeWatches((await this.store.get()).watches);
    }

    /** Adds a watch, or replaces the watch of the same session and worktree. Returns the new watch. */
    async add(watch: Omit<McpWatch, 'id' | 'createdAt'>): Promise<McpWatch> {
        const next: McpWatch = { ...watch, id: randomUUID(), createdAt: this.now() };
        await this.change(list => [...list.filter(item => item.sessionId !== watch.sessionId || item.worktree !== watch.worktree), next]);
        return next;
    }

    /** Removes the watches that match. Returns the removed watches. */
    async remove(match: (watch: McpWatch) => boolean): Promise<McpWatch[]> {
        const removed = (await this.list()).filter(match);
        if (removed.length > 0) await this.change(list => list.filter(watch => !match(watch)));
        return removed;
    }

    private async change(edit: (list: McpWatch[]) => McpWatch[]): Promise<void> {
        const saved = await this.store.update(value => ({ ...value, watches: edit(normalizeWatches(value.watches)) }));
        this.onChanged(normalizeWatches(saved.watches));
    }
}
