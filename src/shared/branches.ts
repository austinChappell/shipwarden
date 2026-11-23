/** A local branch of a repository, for the Branches page. */
export interface LocalBranch {
    /** The short name, for example "feature/login". */
    name: string;
    /** The SHA of the last commit. */
    commit: string;
    /** The commit date of the last commit, in milliseconds. */
    date: number;
    /** The subject of the last commit. */
    subject: string;
    /** The upstream branch, for example "origin/feature/login". */
    upstream?: string;
    /** The number of commits that the upstream branch does not have. */
    ahead?: number;
    /** The number of commits of the upstream branch that this branch does not have. */
    behind?: number;
    /** True when the upstream branch does not exist on the remote now. */
    gone?: boolean;
    /** The path of the worktree that has this branch checked out. */
    worktree?: string;
}

/** A remote branch of a repository, for the Branches page. */
export interface RemoteBranch {
    /** The short name, for example "origin/feature/login". */
    name: string;
    /** The name of the remote, for example "origin". */
    remote: string;
    /** The name of the branch on the remote, for example "feature/login". */
    branch: string;
    commit: string;
    date: number;
    subject: string;
}

/** The local and remote branches of a repository, the newest commit first. */
export interface BranchDetails {
    /** The path of the main worktree. */
    mainWorktree: string;
    /** The local name of the default branch, for example "main". */
    defaultBranch?: string;
    local: LocalBranch[];
    remote: RemoteBranch[];
    /** The error of the fetch, when the fetch failed. The lists then show the state before the fetch. */
    fetchError?: string;
}

/** The result of a delete of one or more local branches. */
export interface DeleteBranchesResult {
    /** The branches that git deleted. */
    deleted: string[];
    /** The branches with commits that are not merged. They stay. */
    notMerged: string[];
    /** The branches that git did not delete for a different reason. */
    failed: { branch: string; error: string }[];
}

/**
 * The format of `git for-each-ref` that `parseBranchRefs` reads. The fields are separated by NUL. The subject is last,
 * because it is the only free text.
 */
export const BRANCH_REF_FORMAT = [
    '%(refname)',
    '%(objectname)',
    '%(committerdate:unix)',
    '%(upstream:short)',
    '%(upstream:track,nobracket)',
    '%(worktreepath)',
    '%(subject)'
].join('%00');

/** Returns the remote of a remote branch: the longest remote name that is a prefix of `name`. */
export function remoteOf(name: string, remotes: readonly string[]): string | undefined {
    return remotes.filter(remote => name.startsWith(`${remote}/`)).sort((a, b) => b.length - a.length)[0];
}

/** Reads the "ahead 2, behind 1" or "gone" text of `%(upstream:track,nobracket)`. */
function parseTrack(track: string): Pick<LocalBranch, 'ahead' | 'behind' | 'gone'> {
    if (track === 'gone') return { gone: true };
    const ahead = /ahead (\d+)/.exec(track);
    const behind = /behind (\d+)/.exec(track);
    return { ...(ahead ? { ahead: Number(ahead[1]) } : {}), ...(behind ? { behind: Number(behind[1]) } : {}) };
}

/**
 * Reads the output of `git for-each-ref --format=<BRANCH_REF_FORMAT> refs/heads refs/remotes`. The order of the
 * output stays. The symbolic "HEAD" refs of the remotes are not branches, so they are not in the result.
 */
export function parseBranchRefs(output: string, remotes: readonly string[]): { local: LocalBranch[]; remote: RemoteBranch[] } {
    const local: LocalBranch[] = [];
    const remote: RemoteBranch[] = [];
    for (const line of output.split('\n')) {
        const [ref, commit, unix, upstream, track, worktree, ...rest] = line.split('\0');
        if (!ref || !commit) continue;
        const subject = rest.join('\0');
        const date = Number(unix) * 1000 || 0;
        if (ref.startsWith('refs/heads/')) {
            local.push({
                name: ref.slice('refs/heads/'.length),
                commit,
                date,
                subject,
                ...(upstream ? { upstream } : {}),
                ...(upstream && track ? parseTrack(track) : {}),
                ...(worktree ? { worktree } : {})
            });
        } else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) {
            const name = ref.slice('refs/remotes/'.length);
            const remoteName = remoteOf(name, remotes) ?? name.split('/')[0];
            remote.push({ name, remote: remoteName, branch: name.slice(remoteName.length + 1), commit, date, subject });
        }
    }
    return { local, remote };
}

/** Why a local branch cannot be deleted, or undefined when it can. */
export function localDeleteBlock(branch: LocalBranch, details: Pick<BranchDetails, 'defaultBranch' | 'mainWorktree'>): string | undefined {
    if (branch.name === details.defaultBranch) return 'ShipWarden does not delete the default branch.';
    if (branch.worktree === details.mainWorktree) return 'The main folder has this branch checked out. Check out a different branch first.';
    if (branch.worktree) return 'A worktree has this branch checked out. Remove the worktree first.';
    return undefined;
}

/** Why a remote branch cannot be deleted, or undefined when it can. */
export function remoteDeleteBlock(branch: RemoteBranch, defaultBranch: string | undefined): string | undefined {
    return branch.branch === defaultBranch ? 'ShipWarden does not delete the default branch.' : undefined;
}

/** The local branches that "Delete all local branches" deletes: all branches that `localDeleteBlock` permits. */
export function bulkDeletable(details: BranchDetails): LocalBranch[] {
    return details.local.filter(branch => !localDeleteBlock(branch, details));
}

/**
 * Returns the branch list after a delete of local branches. A write updates the cache, so the page does not load the
 * list again.
 */
export function withoutLocal(details: BranchDetails, deleted: readonly string[]): BranchDetails {
    const gone = new Set(deleted);
    return { ...details, local: details.local.filter(branch => !gone.has(branch.name)) };
}

/**
 * Returns the branch list after a delete of a remote branch. The local branches that track it get `gone`, as git
 * shows after a fetch.
 */
export function withoutRemote(details: BranchDetails, deleted: string): BranchDetails {
    return {
        ...details,
        remote: details.remote.filter(branch => branch.name !== deleted),
        local: details.local.map(branch => {
            if (branch.upstream !== deleted) return branch;
            const { ahead: _ahead, behind: _behind, ...rest } = branch;
            return { ...rest, gone: true };
        })
    };
}
