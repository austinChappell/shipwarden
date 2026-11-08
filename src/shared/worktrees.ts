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
