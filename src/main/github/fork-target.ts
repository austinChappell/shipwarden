import { parseGitHubRemote, type ForkTarget, type PullRequestInto, type RepoRef } from '@shared/github';

/** Runs git in the folder and returns the output. A failed command rejects. */
export type RunGit = (cwd: string, args: string[]) => Promise<string>;

/** The repository that gets the pull requests of a worktree, and the owner of the branches. */
export interface PullTarget {
    /** The repository that gets the pull requests. */
    repo: RepoRef;
    /** The owner of the repository that has the branches: the owner of the "origin" remote. */
    headOwner: string;
    /** Set when the "origin" remote is a fork. */
    fork?: ForkTarget;
}

/** The git config key that `gh repo set-default` writes. The value "base" marks the remote that gets the pull requests. */
const RESOLVED_KEY = 'gh-resolved';

export function sameRepo(a: RepoRef, b: RepoRef): boolean {
    return a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();
}

/** Returns the `head` value of a pull request: "owner:branch" for a branch in a fork, else the branch name. */
export function headOf(target: PullTarget, branch: string): string {
    return target.headOwner.toLowerCase() === target.repo.owner.toLowerCase() ? branch : `${target.headOwner}:${branch}`;
}

/** Returns the remotes of the repository with their GitHub repository. A remote of another host is not in the result. */
async function githubRemotes(git: RunGit, root: string): Promise<{ name: string; repo: RepoRef }[]> {
    const names = (await git(root, ['remote']).catch(() => '')).split('\n').filter(Boolean);
    const remotes = await Promise.all(
        names.map(async name => ({ name, repo: parseGitHubRemote(await git(root, ['remote', 'get-url', name]).catch(() => '')) }))
    );
    return remotes.filter((remote): remote is { name: string; repo: RepoRef } => !!remote.repo);
}

/**
 * Returns the repository that `gh repo set-default` selected, or undefined when there is no selection.
 * The new gh writes "base" on the selected remote. An old gh wrote "owner/name".
 */
export async function selectedRepo(git: RunGit, root: string): Promise<RepoRef | undefined> {
    const lines = await git(root, ['config', '--get-regexp', `^remote\\..*\\.${RESOLVED_KEY}$`]).catch(() => '');
    for (const line of lines.split('\n')) {
        const space = line.indexOf(' ');
        if (space < 0) continue;
        const key = line.slice(0, space);
        const value = line.slice(space + 1).trim();
        if (value === 'base') {
            const remote = key.slice('remote.'.length, -`.${RESOLVED_KEY}`.length);
            const repo = parseGitHubRemote(await git(root, ['remote', 'get-url', remote]).catch(() => ''));
            if (repo) return repo;
        } else {
            const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value);
            if (match) return { owner: match[1], name: match[2] };
        }
    }
    return undefined;
}

/**
 * Returns the pull request target of a worktree. Returns null when "origin" is not a GitHub repository.
 * - "origin" is not a fork: the pull requests go to "origin".
 * - "origin" is a fork: the pull requests go to the parent, except when `gh repo set-default` selected the fork.
 */
export async function resolvePullTarget(git: RunGit, root: string, parentOf: (repo: RepoRef) => Promise<RepoRef | null>): Promise<PullTarget | null> {
    const origin = parseGitHubRemote(await git(root, ['remote', 'get-url', 'origin']).catch(() => ''));
    if (!origin) return null;
    const parent = await parentOf(origin);
    if (!parent) return { repo: origin, headOwner: origin.owner };
    const selected = await selectedRepo(git, root);
    const into: PullRequestInto = selected && sameRepo(selected, origin) ? 'origin' : 'parent';
    return { repo: into === 'parent' ? parent : origin, headOwner: origin.owner, fork: { origin, parent, into } };
}

/** Returns the clone URL of a repository with the protocol of the "origin" URL: SSH or HTTPS. */
export function cloneUrlLike(originUrl: string, repo: RepoRef): string {
    return /^https:/i.test(originUrl.trim()) ? `https://github.com/${repo.owner}/${repo.name}.git` : `git@github.com:${repo.owner}/${repo.name}.git`;
}

/**
 * Selects the repository that gets the pull requests, as `gh repo set-default` does. The git config is shared, so the
 * change applies to all worktrees of the repository. For the parent, it adds an "upstream" remote when no remote has
 * the parent.
 */
export async function setPullRequestInto(git: RunGit, root: string, fork: ForkTarget, into: PullRequestInto): Promise<void> {
    const remotes = await githubRemotes(git, root);
    const wanted = into === 'parent' ? fork.parent : fork.origin;
    let remote = remotes.find(item => item.name === 'origin' && sameRepo(item.repo, wanted)) ?? remotes.find(item => sameRepo(item.repo, wanted));
    if (!remote) {
        const names = new Set((await git(root, ['remote'])).split('\n').filter(Boolean));
        const name = ['upstream', 'parent', wanted.owner].find(candidate => !names.has(candidate));
        if (!name) throw new Error(`ShipWarden cannot add a remote for ${wanted.owner}/${wanted.name}. Add it with "git remote add".`);
        const originUrl = await git(root, ['remote', 'get-url', 'origin']);
        await git(root, ['remote', 'add', name, cloneUrlLike(originUrl, wanted)]);
        remote = { name, repo: wanted };
    }
    const names = (await git(root, ['remote'])).split('\n').filter(Boolean);
    for (const name of names) {
        if (name !== remote.name) await git(root, ['config', '--unset-all', `remote.${name}.${RESOLVED_KEY}`]).catch(() => '');
    }
    await git(root, ['config', `remote.${remote.name}.${RESOLVED_KEY}`, 'base']);
}
