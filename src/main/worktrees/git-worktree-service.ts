import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CreateWorktreeOptions, Worktree } from '@shared/worktrees';
import { ignoredUnits, selectCopyEntries, type CopyIgnoredSettings } from '@shared/worktree-settings';
import { branchToFolderName, parseWorktreePorcelain } from './porcelain';

/** The time limit for "git fetch" before a new worktree. Without network, git uses HEAD. */
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Returns the folder that contains the new worktrees.
 * The SHIPWARDEN_WORKTREES_DIR environment variable changes this folder.
 */
export function worktreesRoot(): string {
    return process.env.SHIPWARDEN_WORKTREES_DIR || process.env.YARDMASTER_WORKTREES_DIR || path.join(os.homedir(), '.shipwarden', 'worktrees');
}

/** Lists, creates and removes git worktrees with the git command line. */
export class GitWorktreeService {

    /** Returns all worktrees of the repository. The main worktree is first. */
    async list(repoPath: string): Promise<Worktree[]> {
        const output = await this.git(repoPath, ['worktree', 'list', '--porcelain']);
        return parseWorktreePorcelain(output);
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
        // A new branch starts from the newest default branch of "origin", not from a local branch that can be old.
        const base = branchExists ? undefined : options.baseRef ?? await this.remoteDefaultBranch(main.path);
        // --no-track: the new branch must not push to the default branch by mistake.
        const args = branchExists
            ? ['worktree', 'add', target, branch]
            : ['worktree', 'add', '--no-track', '-b', branch, target, ...(base ? [base] : [])];
        await this.git(main.path, args);

        const created = await this.find(main.path, target);
        if (!created) {
            throw new Error(`Git added the worktree, but ShipWarden cannot find it at "${target}".`);
        }
        return created;
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
     * Deletes a local branch. Without `force`, git refuses a branch with commits that are not merged, and the result
     * says so, so the user can choose. The remote branch stays.
     */
    async deleteBranch(repoPath: string, branch: string, force = false): Promise<{ deleted: boolean; notMerged?: boolean }> {
        try {
            await this.git(repoPath, ['branch', force ? '-D' : '-d', '--', branch]);
            return { deleted: true };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!force && /not fully merged/i.test(message)) {
                return { deleted: false, notMerged: true };
            }
            throw error;
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
            if (await this.realpath(worktree.path) === wanted) {
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
            console.warn(`[worktrees] The fetch from origin failed. The new branch starts from HEAD. ${error instanceof Error ? error.message : String(error)}`);
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
