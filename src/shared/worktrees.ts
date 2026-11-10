/** One git worktree of a repository. */
export interface Worktree {
    /** The absolute path of the worktree folder. */
    path: string;
    /** The short branch name, for example `feature/login`. It is undefined when HEAD is detached. */
    branch?: string;
    /** The commit SHA of HEAD. It is empty for a bare repository. */
    head: string;
    /** True for the main worktree of the repository. */
    isMain: boolean;
    isBare: boolean;
    locked: boolean;
    prunable: boolean;
    /** The time in milliseconds when git made the worktree. The main worktree uses the time of its .git folder. */
    createdAt?: number;
    /**
     * The time in milliseconds of the last change in the worktree: a commit, a checkout or a change to the index.
     * Git changes the index when files change and git reads the status.
     */
    updatedAt?: number;
}

/** A new worktree, with the git-ignored files that ShipWarden copied into it. */
export interface CreatedWorktree extends Worktree {
    copied: string[];
    /** The reason when the copy failed. The worktree exists. */
    copyError?: string;
}

/** The result of a removal. A failed teardown script stops the removal. */
export interface RemoveWorktreeResult {
    removed: boolean;
    teardownFailed?: { code: number | null; timedOut: boolean; output: string };
}

export interface CreateWorktreeOptions {
    /** A path in the repository. Any worktree of the repository is permitted. */
    repoPath: string;
    /** The branch for the new worktree. If the branch does not exist, the service creates it. */
    branch: string;
    /** The start point of a new branch. The default is HEAD of the main worktree. */
    baseRef?: string;
    /**
     * A remote branch to check out, for example "origin/feature/login". If the local branch does not exist, the
     * service creates it from this remote branch and sets it to track the remote branch. Then `baseRef` does not apply.
     */
    trackRef?: string;
}

/** The branches that a new worktree can start from. */
export interface BranchList {
    /** The local branches, the newest commit first. */
    local: string[];
    /** The remote branches, for example "origin/main", the newest commit first. */
    remote: string[];
    /** The default start point: the default branch of "origin" after a fetch, for example "origin/main". */
    defaultBase?: string;
    /** The names of the remotes, for example "origin". */
    remotes: string[];
}

/**
 * Returns the local branch name for a remote branch: "origin/feature/login" becomes "feature/login". The longest
 * remote name that matches wins, because a remote name can contain "/". Returns undefined when no remote matches.
 */
export function localNameOfRemote(remoteRef: string, remotes: readonly string[]): string | undefined {
    const remote = [...remotes].sort((a, b) => b.length - a.length).find(name => remoteRef.startsWith(`${name}/`));
    const local = remote ? remoteRef.slice(remote.length + 1) : '';
    return local || undefined;
}

/**
 * Makes a branch name from a display name: "Fix the login page!" becomes "fix-the-login-page". The result has only
 * lowercase letters, digits, "-", "_", "." and "/", and is at most 60 characters.
 */
export function branchFromName(name: string): string {
    return name
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9._/-]+/g, '-')
        .replace(/\/+/g, '/')
        .replace(/-{2,}/g, '-')
        .replace(/(^|\/)[-.]+|[-.]+($|\/)/g, '$1$2')
        .slice(0, 60)
        .replace(/[-./]+$/, '');
}

/** The name of a worktree in the sidebar: its display name, else its branch, else its short commit. */
export function worktreeLabel(worktree: Worktree, names: Record<string, string> | undefined): string {
    return names?.[worktree.path] || worktree.branch || `detached ${worktree.head.slice(0, 7)}`;
}

/** The ways to sort the worktrees of a repository in the sidebar. */
export type WorktreeSortKey = 'name' | 'created' | 'updated';

export interface WorktreeSort {
    by: WorktreeSortKey;
    direction: 'asc' | 'desc';
}

export const DEFAULT_WORKTREE_SORT: WorktreeSort = { by: 'created', direction: 'asc' };

export const WORKTREE_SORT_LABELS: Record<WorktreeSortKey, string> = {
    name: 'Name',
    created: 'Date created',
    updated: 'Last updated'
};

/** Converts a stored value to a valid sort. A wrong value gets the default. */
export function normalizeWorktreeSort(value: unknown): WorktreeSort {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const by = raw.by === 'name' || raw.by === 'created' || raw.by === 'updated' ? raw.by : DEFAULT_WORKTREE_SORT.by;
    const direction = raw.direction === 'desc' ? 'desc' : raw.direction === 'asc' ? 'asc' : DEFAULT_WORKTREE_SORT.direction;
    return { by, direction };
}

/**
 * Returns the worktrees in the sort order. The main worktree is always first.
 * Worktrees with the same value, or without a date, keep the order of git. A worktree without a date goes last.
 */
export function sortWorktrees(worktrees: readonly Worktree[], sort: WorktreeSort, names?: Record<string, string>): Worktree[] {
    const sign = sort.direction === 'asc' ? 1 : -1;
    const compare = (a: Worktree, b: Worktree): number => {
        if (sort.by === 'name') {
            return sign * worktreeLabel(a, names).localeCompare(worktreeLabel(b, names), undefined, { numeric: true, sensitivity: 'base' });
        }
        const key = sort.by === 'created' ? 'createdAt' : 'updatedAt';
        const left = a[key];
        const right = b[key];
        if (left === undefined || right === undefined) {
            return (left === undefined ? 1 : 0) - (right === undefined ? 1 : 0);
        }
        return sign * (left - right);
    };
    const main = worktrees.filter(worktree => worktree.isMain);
    const linked = worktrees.filter(worktree => !worktree.isMain).sort(compare);
    return [...main, ...linked];
}

/**
 * A worktree that the sidebar does not show. The worktree stays on disk.
 * Without `until`, the worktree stays hidden until the user shows it again. With `until`, it is snoozed: it shows
 * again at that time in milliseconds.
 */
export interface HiddenWorktree {
    until?: number;
}

/** Keeps the entries with an absolute path. A wrong `until` makes the entry hidden without an end. */
export function normalizeHiddenWorktrees(value: unknown): Record<string, HiddenWorktree> | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([path, entry]) => path.startsWith('/') && !!entry && typeof entry === 'object')
        .map(([path, entry]): [string, HiddenWorktree] => {
            const until = (entry as Record<string, unknown>).until;
            return [path, typeof until === 'number' && Number.isFinite(until) && until > 0 ? { until } : {}];
        });
    return entries.length ? Object.fromEntries(entries) : undefined;
}

/** True when the entry hides its worktree at the time `now`. A snooze that ended does not hide. */
export function isHiddenAt(entry: HiddenWorktree | undefined, now: number): boolean {
    return !!entry && (entry.until === undefined || entry.until > now);
}

/** Removes the snoozes that ended before `now`. Returns undefined when no entry stays. */
export function pruneHiddenWorktrees(hidden: Record<string, HiddenWorktree> | undefined, now: number): Record<string, HiddenWorktree> | undefined {
    const entries = Object.entries(hidden ?? {}).filter(([, entry]) => isHiddenAt(entry, now));
    return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Returns the time of the next snooze end after `now`, or undefined when no snooze is active. */
export function nextSnoozeEnd(hidden: Record<string, HiddenWorktree> | undefined, now: number): number | undefined {
    const ends = Object.values(hidden ?? {})
        .map(entry => entry.until)
        .filter((until): until is number => until !== undefined && until > now);
    return ends.length ? Math.min(...ends) : undefined;
}

/** The snooze durations of the worktree menu. */
export type SnoozeOption = 'hour' | 'fourHours' | 'tomorrow' | 'nextWeek';

export const SNOOZE_LABELS: Record<SnoozeOption, string> = {
    hour: 'For 1 Hour',
    fourHours: 'For 4 Hours',
    tomorrow: 'Until Tomorrow',
    nextWeek: 'Until Next Week'
};

/** The hour of the local day when "tomorrow" and "next week" end. */
const SNOOZE_MORNING_HOUR = 9;

/** Returns the end of a snooze that starts at `now`, in local time. "Next week" ends on the next Monday. */
export function snoozeEnd(option: SnoozeOption, now: Date): number {
    if (option === 'hour') return now.getTime() + 60 * 60 * 1000;
    if (option === 'fourHours') return now.getTime() + 4 * 60 * 60 * 1000;
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), SNOOZE_MORNING_HOUR);
    // getDay() is 0 on Sunday and 1 on Monday. The next Monday is 1 to 7 days later.
    const days = option === 'tomorrow' ? 1 : (8 - now.getDay()) % 7 || 7;
    end.setDate(end.getDate() + days);
    return end.getTime();
}

/** The text that tells when a snooze ends, for example "until 3:00 PM" or "until Mon 9:00 AM". */
export function snoozeText(until: number, now: number): string {
    const end = new Date(until);
    const time = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const sameDay = new Date(now).toDateString() === end.toDateString();
    const soon = until - now < 6 * 24 * 60 * 60 * 1000;
    if (sameDay) return `until ${time}`;
    if (soon) return `until ${end.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
    return `until ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}
