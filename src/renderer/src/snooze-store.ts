import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { PipelineApprovalItem } from '@shared/dashboard';
import type { IsSnoozed } from '@shared/review-queue';
import {
    isSnoozeActive,
    nextSnoozeEnd,
    openPullRequestActivity,
    pipelineSnoozeKey,
    snoozeKey,
    type PullRequestActivity,
    type Snooze,
    type Snoozes
} from '@shared/snooze';

/** The longest delay of a timer in the browser. A longer delay fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The snoozes of pull requests, pipeline runs, and pipelines. The main process keeps them in a file. This store keeps a copy, so that the views can
 * update at once. When a timed snooze ends, the store tells the views, so the pull request shows again.
 */
class SnoozeStore {
    private snoozes: Snoozes = {};
    private version = 0;
    private loaded: Promise<void> | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly listeners = new Set<() => void>();

    load(): Promise<void> {
        this.loaded ??= window.shipwarden.snoozes.list().then(
            snoozes => {
                // A snooze from this session wins over the file, because the file can be older.
                this.snoozes = { ...snoozes, ...this.snoozes };
                this.changed();
            },
            () => {
                // Without the file, no pull request is snoozed. The next snooze writes the file.
            }
        );
        return this.loaded;
    }

    get(key: string): Snooze | undefined {
        return this.snoozes[key];
    }

    /** Returns all snoozes, also the snoozes that ended. The views check each one with `useSnoozeCheck`. */
    all(): Snoozes {
        return this.snoozes;
    }

    /** Sets the snooze of a key (see `snoozeKey`, `runSnoozeKey`, and `pipelineSnoozeKey`). Null removes the snooze. */
    set(key: string, snooze: Snooze | null): void {
        const next = { ...this.snoozes };
        if (snooze) next[key] = snooze;
        else delete next[key];
        this.snoozes = next;
        this.changed();
        window.shipwarden.snoozes.set(key, snooze).catch(() => {
            // The snooze stays in memory for this session.
        });
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getVersion = (): number => this.version;

    private changed(): void {
        this.version += 1;
        this.schedule();
        this.listeners.forEach(listener => listener());
    }

    /** Starts a timer for the next end of a timed snooze. */
    private schedule(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        const now = Date.now();
        const next = nextSnoozeEnd(this.snoozes, now);
        if (next === undefined) return;
        this.timer = setTimeout(() => this.changed(), Math.min(next - now + 50, MAX_TIMER_MS));
    }
}

export const snoozeStore = new SnoozeStore();

/** Returns the snooze of the key that hides the item now, or undefined. */
export type SnoozeCheck = (key: string, activity: PullRequestActivity) => Snooze | undefined;

/**
 * Returns a function that gives the active snooze of a key. The function changes when a snooze changes or
 * ends, so that memos that use it update. The hook loads the snoozes when they are not loaded.
 */
export function useSnoozeCheck(): SnoozeCheck {
    const version = useSyncExternalStore(snoozeStore.subscribe, snoozeStore.getVersion);
    useEffect(() => {
        void snoozeStore.load();
    }, []);
    // biome-ignore lint/correctness/useExhaustiveDependencies: The version changes when a snooze changes or ends. A new function then makes the memos update.
    return useMemo(
        () => (key: string, activity: PullRequestActivity) => {
            const snooze = snoozeStore.get(key);
            return isSnoozeActive(snooze, activity, Date.now()) ? snooze : undefined;
        },
        [version]
    );
}

/** Returns a function that tells if a pull request of the Review view is snoozed now. It changes with the snoozes. */
export function useIsSnoozed(): IsSnoozed {
    const check = useSnoozeCheck();
    return useMemo(() => pr => !!check(snoozeKey(pr.url), openPullRequestActivity(pr)), [check]);
}

/** True when a snooze of the pipeline of the run hides the run now. A new run of a snoozed pipeline sends no notification. */
export function isPipelineSnoozed(item: PipelineApprovalItem, now = Date.now()): boolean {
    return !!item.pipeline && isSnoozeActive(snoozeStore.get(pipelineSnoozeKey(item.pipeline.id)), {}, now);
}
