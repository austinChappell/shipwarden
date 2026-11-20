/** The kind of a change of a file in git. */
export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'conflicted';

export interface FileChange {
    /** The path from the worktree root, with "/". */
    path: string;
    /** The path before a rename or a copy. */
    oldPath?: string;
    kind: ChangeKind;
}

/** The local changes of a worktree, from `git status`. */
export interface GitChanges {
    /** The branch. Undefined for a detached HEAD. */
    branch?: string;
    /** The upstream branch, for example "origin/main". */
    upstream?: string;
    /** The commits that the upstream does not have. */
    ahead: number;
    /** The commits of the upstream that the branch does not have. */
    behind: number;
    /** True before the first commit. */
    unborn: boolean;
    /** The changes in the index: the next commit. */
    staged: FileChange[];
    /** The changes in the working files that are not in the index, and the new files that git does not track. */
    unstaged: FileChange[];
    /** The files with merge conflicts. */
    conflicted: FileChange[];
    /** The rebase that is in progress, also when it started outside ShipWarden. Undefined when no rebase runs. */
    rebase?: RebaseState;
}

/** A rebase that stopped and waits for the user, from the rebase folder of git. */
export interface RebaseState {
    /** The branch that the rebase moves. Undefined for a detached HEAD. */
    branch?: string;
    /** The commit that the rebase moves the branch onto. */
    onto: string;
    /** The name of a branch at `onto`, for example "origin/main". Undefined when no branch points at it. */
    ontoName?: string;
    /** The number of the commit that the rebase applies now, from 1. */
    step?: number;
    /** The number of commits that the rebase applies. */
    total?: number;
    /** The commit that stopped the rebase, for example with a conflict. */
    stopped?: { hash: string; subject: string };
}

/** The result of a rebase step: the rebase is complete, or it stopped on a conflict. */
export type RebaseResult =
    | {
          status: 'done';
          /** The branch that the rebase moved onto, for example "origin/main". */
          onto: string;
          /** False when the branch already had all commits of `onto`, so the rebase changed nothing. */
          changed: boolean;
      }
    | { status: 'conflict'; state: RebaseState };

/** The git data of a rebase conflict, for the prompt to an agent. */
export interface RebaseConflictInput {
    /** The branch that the rebase moves. Undefined for a detached HEAD. */
    branch?: string;
    /** The name of the branch that the rebase moves onto, else its short hash. */
    onto: string;
    /** The files with conflicts. */
    files: string[];
    /** The commit that stopped the rebase. */
    stopped?: { hash: string; subject: string };
    /** The commits of the branch that change the files, as "<short hash> <subject>", newest first. */
    branchCommits: string[];
    /** The commits of `onto` since the merge base that change the files, as "<short hash> <subject>", newest first. */
    baseCommits: string[];
}

/** True when the worktree has changes that stop a rebase: staged, unstaged, or conflicted files. New files do not count. */
export function hasUncommittedChanges(changes: Pick<GitChanges, 'staged' | 'unstaged' | 'conflicted'>): boolean {
    return changes.staged.length > 0 || changes.conflicted.length > 0 || changes.unstaged.some(change => change.kind !== 'untracked');
}

/** True when the branch and its upstream both have commits that the other does not have, for example after a rebase. */
export function hasDiverged(changes: Pick<GitChanges, 'upstream' | 'ahead' | 'behind'>): boolean {
    return !!changes.upstream && changes.ahead > 0 && changes.behind > 0;
}

/** Which side of a change a diff shows: HEAD and the index (staged), or the index and the working file (unstaged). */
export type ChangeSide = 'staged' | 'unstaged';

/** The two versions of a file for a diff. */
export interface ChangeContents {
    original: string;
    modified: string;
    /** True when a version is binary. Then the texts are empty. */
    binary: boolean;
}

/** The result of a background fetch of the upstream remote. */
export interface FetchResult {
    /** The time of the last fetch of the repository, in milliseconds. Undefined before the first fetch. */
    at?: number;
    /** The error of the last fetch, for example when the network or the credentials are missing. */
    error?: string;
}

export interface CommitResult {
    /** The short hash of the new commit. */
    hash: string;
    summary: string;
}

const KINDS: Record<string, ChangeKind> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange' };

/**
 * Parses the output of `git status --porcelain=v2 --branch -z --untracked-files=all`.
 * The format: "# branch.*" headers, "1" (changed), "2" (renamed or copied, with the old path in the next field),
 * "u" (unmerged), and "?" (untracked) entries. The fields end with NUL.
 */
export function parseStatus(output: string): GitChanges {
    const result: GitChanges = { ahead: 0, behind: 0, unborn: false, staged: [], unstaged: [], conflicted: [] };
    const fields = output.split('\0');
    for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        if (!field) continue;
        if (field.startsWith('# branch.head ')) {
            const head = field.slice('# branch.head '.length);
            result.branch = head === '(detached)' ? undefined : head;
        } else if (field.startsWith('# branch.oid ')) {
            result.unborn = field.endsWith('(initial)');
        } else if (field.startsWith('# branch.upstream ')) {
            result.upstream = field.slice('# branch.upstream '.length);
        } else if (field.startsWith('# branch.ab ')) {
            const match = /\+(\d+) -(\d+)/.exec(field);
            if (match) {
                result.ahead = Number(match[1]);
                result.behind = Number(match[2]);
            }
        } else if (field.startsWith('1 ') || field.startsWith('2 ')) {
            const parts = field.split(' ');
            const [x, y] = parts[1];
            // A "1" entry has 8 fields before the path. A "2" entry has 9, and the old path is the next NUL field.
            const path = parts.slice(field.startsWith('1 ') ? 8 : 9).join(' ');
            const oldPath = field.startsWith('2 ') ? fields[++index] : undefined;
            if (x !== '.') result.staged.push({ path, ...(oldPath && (x === 'R' || x === 'C') ? { oldPath } : {}), kind: KINDS[x] ?? 'modified' });
            if (y !== '.') result.unstaged.push({ path, kind: KINDS[y] ?? 'modified' });
        } else if (field.startsWith('u ')) {
            result.conflicted.push({ path: field.split(' ').slice(10).join(' '), kind: 'conflicted' });
        } else if (field.startsWith('? ')) {
            result.unstaged.push({ path: field.slice(2), kind: 'untracked' });
        }
    }
    const byPath = (a: FileChange, b: FileChange) => a.path.localeCompare(b.path);
    result.staged.sort(byPath);
    result.unstaged.sort(byPath);
    result.conflicted.sort(byPath);
    return result;
}

/** The one-letter label of a change, as in the git status of an editor. */
export function changeLetter(kind: ChangeKind): string {
    return { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', untracked: 'U', conflicted: '!' }[kind];
}

/** Returns an error message when a path is not a safe relative path in a worktree, else undefined. */
export function changePathError(path: string): string | undefined {
    if (!path || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '') || path.includes('\0')) {
        return `The path "${path}" is not a path in the worktree.`;
    }
    return undefined;
}

/** The number of files with a change, for a badge. A file that is staged and also changed again counts one time. */
export function changeCount(changes: GitChanges): number {
    return new Set([...changes.staged, ...changes.unstaged, ...changes.conflicted].map(change => change.path)).size;
}

/** One file of the changes of a branch since its base: the commits and the working files. */
export interface BranchFileStat {
    /** The path from the worktree root, with "/". */
    path: string;
    /** The path before a rename. */
    oldPath?: string;
    /** The added lines. 0 for a binary file. */
    added: number;
    /** The removed lines. 0 for a binary file. */
    removed: number;
    binary: boolean;
    /** True for a new file that git does not track yet. */
    untracked?: boolean;
}

/** The changes of a branch since its base commit, for the compare list of agent runs. */
export interface BranchDiff {
    /**
     * The base commit: the merge base with the default branch of "origin". Undefined when ShipWarden cannot find it.
     * Then the diff starts at HEAD.
     */
    base?: string;
    files: BranchFileStat[];
}

/**
 * Reads the output of `git diff --numstat -z`. A line is "added<TAB>removed<TAB>path<NUL>". A rename has an empty path
 * and then the old path and the new path, each with a NUL at the end. A binary file has "-" for the counts.
 */
export function parseNumstat(output: string): BranchFileStat[] {
    const parts = output.split('\0');
    const files: BranchFileStat[] = [];
    for (let index = 0; index < parts.length; index++) {
        const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[index]);
        if (!match) continue;
        const binary = match[1] === '-' || match[2] === '-';
        const counts = { added: binary ? 0 : Number(match[1]), removed: binary ? 0 : Number(match[2]), binary };
        if (match[3]) {
            files.push({ path: match[3], ...counts });
            continue;
        }
        const oldPath = parts[index + 1];
        const path = parts[index + 2];
        index += 2;
        if (path) files.push({ path, ...(oldPath && oldPath !== path ? { oldPath } : {}), ...counts });
    }
    return files;
}

/** Returns the totals of a branch diff: the number of files, the added lines, and the removed lines. */
export function diffTotals(files: readonly BranchFileStat[]): { files: number; added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const file of files) {
        added += file.added;
        removed += file.removed;
    }
    return { files: files.length, added, removed };
}
