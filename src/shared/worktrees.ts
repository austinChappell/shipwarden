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

