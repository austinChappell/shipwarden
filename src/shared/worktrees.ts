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
}

/** The branches that a new worktree can start from. */
export interface BranchList {
    /** The local branches, the newest commit first. */
    local: string[];
    /** The remote branches, for example "origin/main", the newest commit first. */
    remote: string[];
    /** The default start point: the default branch of "origin" after a fetch, for example "origin/main". */
    defaultBase?: string;
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
    const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
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
