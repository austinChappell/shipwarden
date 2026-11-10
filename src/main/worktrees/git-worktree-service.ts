import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BranchList, CreateWorktreeOptions, Worktree } from '@shared/worktrees';
import { ignoredUnits, selectCopyEntries, type CopyIgnoredSettings } from '@shared/worktree-settings';
import { branchToFolderName, parseWorktreePorcelain } from './porcelain';

/** The time limit for "git fetch" before a new worktree. Without network, git uses HEAD. */
const FETCH_TIMEOUT_MS = 20_000;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Returns the folder that contains the new worktrees.
 * The SHIPWARDEN_WORKTREES_DIR environment variable changes this folder.
 */
export function worktreesRoot(): string {
    return process.env.SHIPWARDEN_WORKTREES_DIR || process.env.YARDMASTER_WORKTREES_DIR || path.join(os.homedir(), '.shipwarden', 'worktrees');
}

async function birthtime(file: string): Promise<number | undefined> {
    try {
        const stat = await fs.stat(file);
        // Some file systems do not keep the birth time. Then the value is 0, and the change time is the best guess.
        return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
    } catch {
        return undefined;
    }
}

async function mtime(file: string): Promise<number | undefined> {
    try {
        return (await fs.stat(file)).mtimeMs;
    } catch {
        return undefined;
    }
}

/** Lists, creates and removes git worktrees with the git command line. */
export class GitWorktreeService {
    /** Returns all worktrees of the repository. The main worktree is first. */
    async list(repoPath: string): Promise<Worktree[]> {
        const output = await this.git(repoPath, ['worktree', 'list', '--porcelain']);
        return parseWorktreePorcelain(output);
    }

    /**
     * Adds the creation time and the time of the last change to each worktree. A time that cannot be read stays
     * undefined. The function reads only file dates, so it is fast.
     */
    async withDates(worktrees: Worktree[]): Promise<Worktree[]> {
        return Promise.all(
            worktrees.map(async worktree => {
                const gitDir = await this.gitDir(worktree.path);
                const created = await birthtime(gitDir ?? worktree.path);
                const changes = gitDir
                    ? (await Promise.all([mtime(path.join(gitDir, 'logs', 'HEAD')), mtime(path.join(gitDir, 'index'))])).filter(
                          (time): time is number => time !== undefined
                      )
                    : [];
                const updated = changes.length > 0 ? Math.max(...changes) : created;
                return { ...worktree, ...(created !== undefined ? { createdAt: created } : {}), ...(updated !== undefined ? { updatedAt: updated } : {}) };
            })
        );
    }

    /**
     * Returns the git folder of a worktree: the .git folder of the main worktree, or the folder that the .git file of a
     * linked worktree points to. Returns undefined when it cannot be read.
     */
    protected async gitDir(worktreePath: string): Promise<string | undefined> {
        const dotGit = path.join(worktreePath, '.git');
        try {
            if ((await fs.stat(dotGit)).isDirectory()) {
                return dotGit;
            }
            const match = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dotGit, 'utf8'));
            return match ? path.resolve(worktreePath, match[1].trim()) : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Creates a worktree. `parentFolder` is the folder that gets the worktree folder.
     * The default is <worktrees root>/<repository name>.
     */
    async create(options: CreateWorktreeOptions, parentFolder?: string): Promise<Worktree> {
        const branch = options.branch.trim();
        await this.git(options.repoPath, ['check-ref-format', '--branch', branch]);

        const main = (await this.list(options.repoPath)).find(worktree => worktree.isMain);
        if (!main) {
            throw new Error(`ShipWarden cannot find the main worktree of the repository at "${options.repoPath}".`);
        }
        const target = path.join(parentFolder ?? path.join(worktreesRoot(), path.basename(main.path)), branchToFolderName(branch));
        if (await this.exists(target)) {
            throw new Error(`The folder "${target}" exists. Remove the folder or use a different branch name.`);
        }
        await fs.mkdir(path.dirname(target), { recursive: true });

        const branchExists = await this.branchExists(main.path, branch);
        const trackRef = branchExists ? undefined : options.trackRef?.trim();
        if (trackRef && !(await this.remoteBranchExists(main.path, trackRef))) {
            throw new Error(`The remote branch "${trackRef}" does not exist. Fetch the remote and try again.`);
        }
        // A new branch starts from the newest default branch of "origin", not from a local branch that can be old.
        const base = branchExists || trackRef ? undefined : (options.baseRef ?? (await this.remoteDefaultBranch(main.path)));
        // --no-track: the new branch must not push to the default branch by mistake.
        // --track: a checkout of a remote branch pulls from and pushes to that remote branch.
        const args = branchExists
            ? ['worktree', 'add', target, branch]
            : trackRef
              ? ['worktree', 'add', '--track', '-b', branch, target, trackRef]
              : ['worktree', 'add', '--no-track', '-b', branch, target, ...(base ? [base] : [])];
        await this.git(main.path, args);

        const created = await this.find(main.path, target);
        if (!created) {
            throw new Error(`Git added the worktree, but ShipWarden cannot find it at "${target}".`);
        }
        return created;
    }

    /**
     * The branches that a new worktree can start from, the newest commit first, and the default start point. The
     * default start point needs a fetch of "origin", so this can take some seconds.
     */
    async branches(repoPath: string): Promise<BranchList> {
        const main = (await this.list(repoPath)).find(worktree => worktree.isMain);
        const root = main?.path ?? repoPath;
        const defaultBase = await this.remoteDefaultBranch(root);
        const output = await this.git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(refname:short)', 'refs/heads', 'refs/remotes']);
        const local: string[] = [];
        const remote: string[] = [];
        for (const line of output.split('\n')) {
            const [full, short] = line.split('\0');
            if (!full || !short || full.endsWith('/HEAD')) continue;
            if (full.startsWith('refs/heads/')) local.push(short);
            else remote.push(short);
        }
        const remotes = (await this.git(root, ['remote']))
            .split('\n')
            .map(name => name.trim())
            .filter(Boolean);
        return { local, remote, remotes, ...(defaultBase ? { defaultBase } : {}) };
    }

    /** Removes a worktree. This function does not remove the main worktree. */
    async remove(repoPath: string, worktreePath: string, force?: boolean): Promise<void> {
        const worktree = await this.find(repoPath, worktreePath);
        if (!worktree) {
            throw new Error(`The path "${worktreePath}" is not a worktree of this repository.`);
        }
        if (worktree.isMain) {
            throw new Error('ShipWarden does not remove the main worktree.');
        }
        await this.git(repoPath, ['worktree', 'remove', ...(force ? ['--force'] : []), worktree.path]);
    }

    /**
     * Deletes a local branch. Without `force`, ShipWarden first pulls the newest commits of the start branch of
     * the branch. Then git refuses a branch with commits that are not merged, and the result says so, so
     * the user can choose. A failed pull does not stop the delete. The remote branch stays.
     */
    async deleteBranch(repoPath: string, branch: string, force = false): Promise<{ deleted: boolean; notMerged?: boolean }> {
        const bases = force ? [] : await this.pullBase(repoPath, branch);
        try {
            await this.git(repoPath, ['branch', force ? '-D' : '-d', '--', branch]);
            return { deleted: true };
        } catch (error) {
            if (force || !/not fully merged/i.test(errorMessage(error))) {
                throw error;
            }
        }
        // "git branch -d" compares with HEAD or with the upstream branch. The start branch can contain all the commits
        // when HEAD does not. Then no commit is lost.
        for (const base of bases) {
            if (await this.isAncestor(repoPath, branch, base)) {
                await this.git(repoPath, ['branch', '-D', '--', branch]);
                return { deleted: true };
            }
        }
        return { deleted: false, notMerged: true };
    }

    /**
     * Fetches the remote of the branch that `branch` started from, and fast-forwards the local start branch. A branch
     * without a known start point uses the default branch of "origin". Returns the start branches that exist, local
     * and remote. This function does not throw. It writes a warning for each failure.
     */
    protected async pullBase(repoPath: string, branch: string): Promise<string[]> {
        try {
            let fetched: string | undefined;
            let base = await this.startPoint(repoPath, branch);
            if (!base) {
                base = await this.remoteDefaultBranch(repoPath);
                fetched = base ? 'origin' : undefined;
            }
            if (!base) return [];

            const remotes = (await this.git(repoPath, ['remote']))
                .split('\n')
                .map(name => name.trim())
                .filter(Boolean);
            let local: string | undefined;
            let remoteRef: string | undefined;
            if (await this.branchExists(repoPath, base)) {
                local = base;
                remoteRef = await this.upstreamOf(repoPath, base);
            } else if (await this.remoteBranchExists(repoPath, base)) {
                remoteRef = base;
                const remote = remotes.filter(name => base!.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0];
                const name = remote ? base.slice(remote.length + 1) : undefined;
                local = name && (await this.branchExists(repoPath, name)) ? name : undefined;
            } else {
                // The start point is a tag or a commit. There is nothing to pull.
                return [];
            }

            if (remoteRef) {
                const remote = remotes.filter(name => remoteRef!.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0];
                if (remote && remote !== fetched) {
                    await this.git(repoPath, ['fetch', '--quiet', remote], FETCH_TIMEOUT_MS).catch(error =>
                        console.warn(`[worktrees] The fetch from ${remote} failed. ${errorMessage(error)}`)
                    );
                }
                if (local) {
                    await this.fastForward(repoPath, local, remoteRef).catch(error =>
                        console.warn(`[worktrees] Git cannot fast-forward "${local}" to "${remoteRef}". ${errorMessage(error)}`)
                    );
                }
            }
            return [local, remoteRef].filter((ref): ref is string => !!ref);
        } catch (error) {
            console.warn(`[worktrees] ShipWarden cannot pull the start branch of "${branch}". ${errorMessage(error)}`);
            return [];
        }
    }

    /**
     * Moves the local branch `local` to `remoteRef` when this is a fast-forward. If a worktree has the branch, the
     * merge runs in that worktree. Git refuses a merge that changes local changes.
     */
    protected async fastForward(repoPath: string, local: string, remoteRef: string): Promise<void> {
        const worktree = (await this.list(repoPath)).find(item => item.branch === local);
        if (worktree) {
            await this.git(worktree.path, ['merge', '--ff-only', '--quiet', remoteRef]);
        } else {
            await this.git(repoPath, ['fetch', '--quiet', '.', `refs/remotes/${remoteRef}:refs/heads/${local}`]);
        }
    }

    /**
     * Returns the start point of a branch from its first reflog entry, for example "origin/main". Git writes
     * "branch: Created from <start point>" when it creates a branch. Returns undefined when the entry is "HEAD", or when
     * the entry does not exist. Git deletes old reflog entries, by default after 90 days.
     */
    protected async startPoint(repoPath: string, branch: string): Promise<string | undefined> {
        try {
            const entries = (await this.git(repoPath, ['reflog', 'show', '--format=%gs', `refs/heads/${branch}`, '--'])).trim().split('\n');
            const match = /^branch: Created from (.+)$/.exec(entries[entries.length - 1]?.trim() ?? '');
            const start = match?.[1].trim();
            return start && start !== 'HEAD' ? start.replace(/^refs\/(heads|remotes)\//, '') : undefined;
        } catch {
            return undefined;
        }
    }

    /** Returns the upstream branch of a local branch, for example "origin/main", or undefined. */
    protected async upstreamOf(repoPath: string, branch: string): Promise<string | undefined> {
        try {
            const upstream = (await this.git(repoPath, ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`])).trim();
            return upstream && (await this.remoteBranchExists(repoPath, upstream)) ? upstream : undefined;
        } catch {
            return undefined;
        }
    }

    /** True when all the commits of `ref` are in `base`. */
    protected async isAncestor(repoPath: string, ref: string, base: string): Promise<boolean> {
        try {
            await this.git(repoPath, ['merge-base', '--is-ancestor', `refs/heads/${ref}`, base]);
            return true;
        } catch {
            return false;
        }
    }

    /** Returns the changed and new files of a worktree, as "git status --porcelain" shows them. Empty means clean. */
    async uncommittedChanges(worktreePath: string): Promise<string> {
        return (await this.git(worktreePath, ['status', '--porcelain'])).trim();
    }

    /**
     * Returns the git-ignored files and folders of the main worktree that the copy settings copy, as paths from its root.
     * A folder has "/" at the end. Git lists an ignored folder (for example node_modules/) as one entry.
     */
    async ignoredMatches(repoPath: string, copy: CopyIgnoredSettings): Promise<string[]> {
        if (!copy.enabled) return [];
        const main = (await this.list(repoPath)).find(worktree => worktree.isMain);
        if (!main) return [];
        const output = await this.git(main.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
        return selectCopyEntries(ignoredUnits(output.split('\0').filter(Boolean)), copy).sort();
    }

    /**
     * Copies the git-ignored files of the copy settings from the main worktree to a new worktree, for example ".env".
     * A file that exists in the new worktree stays. Returns the copied paths.
     */
    async copyIgnored(repoPath: string, worktreePath: string, copy: CopyIgnoredSettings): Promise<string[]> {
        const main = (await this.list(repoPath)).find(worktree => worktree.isMain);
        if (!main) return [];
        const copied: string[] = [];
        for (const entry of await this.ignoredMatches(repoPath, copy)) {
            const relative = entry.replace(/\/+$/, '');
            const from = path.join(main.path, relative);
            const to = path.join(worktreePath, relative);
            if (await this.exists(to)) continue;
            await fs.mkdir(path.dirname(to), { recursive: true });
            await fs.cp(from, to, { recursive: true, errorOnExist: false, force: false, preserveTimestamps: true });
            copied.push(entry);
        }
        return copied;
    }

    protected async find(repoPath: string, worktreePath: string): Promise<Worktree | undefined> {
        const wanted = await this.realpath(worktreePath);
        for (const worktree of await this.list(repoPath)) {
            if ((await this.realpath(worktree.path)) === wanted) {
                return worktree;
            }
        }
        return undefined;
    }

    /**
     * Fetches "origin" and returns its default branch, for example "origin/main".
     * Returns undefined when the repository has no "origin" remote or the fetch fails. Then git uses HEAD.
     */
    protected async remoteDefaultBranch(repoPath: string): Promise<string | undefined> {
        try {
            await this.git(repoPath, ['remote', 'get-url', 'origin']);
        } catch {
            return undefined;
        }
        try {
            await this.git(repoPath, ['fetch', '--quiet', 'origin'], FETCH_TIMEOUT_MS);
        } catch (error) {
            console.warn(`[worktrees] The fetch from origin failed. The new branch starts from HEAD. ${errorMessage(error)}`);
            return undefined;
        }
        const candidates: string[] = [];
        try {
            candidates.push((await this.git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim());
        } catch {
            // origin/HEAD is not set, for example in a repository that "git init" made. Try the usual names.
        }
        candidates.push('origin/main', 'origin/master');
        for (const candidate of candidates) {
            try {
                await this.git(repoPath, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
                return candidate;
            } catch {
                // This branch does not exist. Try the next one.
            }
        }
        return undefined;
    }

    protected async branchExists(repoPath: string, branch: string): Promise<boolean> {
        try {
            await this.git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
            return true;
        } catch {
            return false;
        }
    }

    /** True when `ref` is a branch under refs/remotes, for example "origin/feature". */
    protected async remoteBranchExists(repoPath: string, ref: string): Promise<boolean> {
        try {
            await this.git(repoPath, ['show-ref', '--verify', '--quiet', `refs/remotes/${ref}`]);
            return true;
        } catch {
            return false;
        }
    }

    protected async exists(target: string): Promise<boolean> {
        try {
            await fs.access(target);
            return true;
        } catch {
            return false;
        }
    }

    /** Resolves symbolic links. On macOS, /tmp is a link to /private/tmp. */
    protected async realpath(target: string): Promise<string> {
        try {
            return await fs.realpath(target);
        } catch {
            return path.resolve(target);
        }
    }

    protected git(cwd: string, args: string[], timeout = 0): Promise<string> {
        return new Promise((resolve, reject) => {
            execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout }, (error, stdout, stderr) => {
                if (error) {
                    const detail = (stderr || error.message).trim();
                    reject(new Error(`The command "git ${args.join(' ')}" failed: ${detail}`));
                } else {
                    resolve(stdout);
                }
            });
        });
    }
}
