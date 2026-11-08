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
