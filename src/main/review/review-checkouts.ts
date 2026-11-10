import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { RepoRef } from '@shared/github';
import { reviewCheckoutKey, type ReviewCheckout, type ReviewCheckoutStatus } from '@shared/review-checkout';
import { JsonStore } from '../tasks/json-store';

/** The time limit for a fetch of the head of a pull request. */
const FETCH_TIMEOUT_MS = 120_000;
/** The time limit for a clone. A large repository needs time. */
const CLONE_TIMEOUT_MS = 15 * 60_000;
/** A checkout that the user did not open for this time goes away at the next start. */
export const UNUSED_CHECKOUT_MS = 7 * 24 * 60 * 60_000;

export interface GitOptions {
    timeout?: number;
}

/** Runs git in a folder and returns the output. Rejects when git fails. */
export type GitRunner = (cwd: string, args: string[], options?: GitOptions) => Promise<string>;

interface IndexEntry {
    owner: string;
    name: string;
    number: number;
    /** The folder of the checkout. */
    root: string;
    /** The repository that has the worktree of the checkout. */
    repoPath: string;
    sha: string;
    usedAt: number;
}

interface IndexFile {
    checkouts: Record<string, IndexEntry>;
}

/**
 * Git must not ask for a password. A hook of the repository must not run, and Git LFS must not download files.
 * The checkout is only for reading code.
 */
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' };
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

export const runGit: GitRunner = (cwd, args, options = {}) =>
    new Promise((resolve, reject) => {
        execFile('git', [...NO_HOOKS, ...args], { cwd, env: GIT_ENV, maxBuffer: 16 * 1024 * 1024, timeout: options.timeout ?? 0 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`git ${args[0]} failed: ${(stderr || error.message).trim()}`));
            } else {
                resolve(stdout);
            }
        });
    });

export interface ReviewCheckoutsOptions {
    /** The folder for the checkouts and for the clones of ShipWarden, for example ~/.shipwarden/review. */
    folder: string;
    /** The JSON file of the index. */
    indexFile: string;
    /** Returns the main worktree of a project repository whose "origin" remote is the GitHub repository. */
    findClone(repo: RepoRef): Promise<string | undefined>;
    git?: GitRunner;
    now?: () => number;
}

/**
 * Keeps local copies of pull requests for the Review view. The language servers and the file explorer need the
 * files on disk. Each copy is a detached git worktree at the head commit of the pull request:
 * <folder>/<owner>/<name>/pr-<number>.
 *
 * The worktree belongs to the project repository of the GitHub repository. Without such a project, ShipWarden
 * clones the repository to <folder>/<owner>/<name>/repo (without file contents, git gets them when necessary).
 */
export class ReviewCheckouts {
    private readonly index: JsonStore<IndexFile>;
    private readonly git: GitRunner;
    private readonly now: () => number;
    /** The checkout that runs for each pull request. A second call waits for the same checkout. */
    private readonly running = new Map<string, Promise<ReviewCheckout>>();
    /** The git operations of each repository run one at a time. Two fetches at the same time can fail on a lock. */
    private readonly repoQueues = new Map<string, Promise<unknown>>();

    constructor(private readonly options: ReviewCheckoutsOptions) {
        this.index = new JsonStore<IndexFile>(options.indexFile, () => ({ checkouts: {} }));
        this.git = options.git ?? runGit;
        this.now = options.now ?? Date.now;
    }

    /** True when the path is in the folder of the checkouts. The sidebar does not show these worktrees. */
    isInFolder(target: string): boolean {
        const relative = path.relative(this.options.folder, path.resolve(target));
        return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    }

    /** True when the path is the folder of a checkout in the index. */
    async has(root: string): Promise<boolean> {
        const file = await this.index.get();
        return Object.values(this.entries(file)).some(entry => entry.root === root);
    }

    async status(repo: RepoRef, number: number): Promise<ReviewCheckoutStatus> {
        const entry = this.entries(await this.index.get())[reviewCheckoutKey(repo, number)];
        const checkout = entry && (await this.exists(entry.root)) ? { root: entry.root, sha: entry.sha } : undefined;
        const needsClone = !checkout && !(await this.options.findClone(repo)) && !(await this.exists(this.clonePath(repo)));
        return { ...(checkout ? { checkout } : {}), needsClone };
    }

    /**
     * Makes or updates the checkout of a pull request at the commit `sha`. Fetches the head of the pull request when
     * the repository does not have the commit. Clones the repository first only when `allowClone` is true.
     */
    ensure(repo: RepoRef, number: number, sha: string, allowClone: boolean): Promise<ReviewCheckout> {
        const key = reviewCheckoutKey(repo, number);
        const current = this.running.get(key);
        if (current) return current;
        const promise = this.make(repo, number, sha, allowClone).finally(() => this.running.delete(key));
        this.running.set(key, promise);
        return promise;
    }

    /**
     * Removes the checkouts that the user did not open for `maxAgeMs`. Removes a clone of ShipWarden when it has no
     * more checkouts. Returns the removed folders.
     */
    async prune(maxAgeMs = UNUSED_CHECKOUT_MS): Promise<string[]> {
        const entries = Object.entries(this.entries(await this.index.get()));
        const old = entries.filter(([, entry]) => this.now() - entry.usedAt > maxAgeMs);
        const removed: string[] = [];
        for (const [key, entry] of old) {
            await this.removeWorktree(entry);
            await this.index.update(file => {
                delete this.entries(file)[key];
            });
            removed.push(entry.root);
        }
        const remaining = Object.values(this.entries(await this.index.get()));
        for (const [, entry] of old) {
            const clone = this.clonePath(entry);
            if (entry.repoPath === clone && !remaining.some(other => other.repoPath === clone) && (await this.exists(clone))) {
                await fs.rm(clone, { recursive: true, force: true });
                removed.push(clone);
            }
        }
        return removed;
    }

    private async make(repo: RepoRef, number: number, sha: string, allowClone: boolean): Promise<ReviewCheckout> {
        const key = reviewCheckoutKey(repo, number);
        const root = this.checkoutPath(repo, number);
        const old = this.entries(await this.index.get())[key];
        // A checkout stays in the repository that has its worktree, also when a project adds a clone later.
        let repoPath = old && old.root === root && (await this.isWorktreeOf(old.repoPath, root)) ? old.repoPath : undefined;
        repoPath ??= await this.options.findClone(repo);
        if (!repoPath && (await this.exists(path.join(this.clonePath(repo), '.git')))) {
            repoPath = this.clonePath(repo);
        }
        if (!repoPath) {
            if (!allowClone) {
                throw new Error(`No project has a clone of ${repo.owner}/${repo.name}. ShipWarden must clone the repository first.`);
            }
            repoPath = await this.clone(repo);
        }
        const source = repoPath;

        await this.queue(source, async () => {
            if (!(await this.hasCommit(source, sha))) {
                // A pull request from a fork also has this ref in the base repository.
                await this.git(source, ['fetch', '--quiet', '--no-tags', 'origin', `refs/pull/${number}/head`], { timeout: FETCH_TIMEOUT_MS });
                if (!(await this.hasCommit(source, sha))) {
                    throw new Error(`The commit ${sha.slice(0, 7)} is not the head of pull request #${number} now. Refresh the pull request and try again.`);
                }
            }
            if (await this.isWorktreeOf(source, root)) {
                const head = (await this.git(root, ['rev-parse', 'HEAD'])).trim();
                // The checkout is only for reading, so --force is safe. Untracked files (for example node_modules) stay.
                if (head !== sha) await this.git(root, ['checkout', '--quiet', '--force', '--detach', sha]);
                return;
            }
            if (await this.exists(root)) {
                // The folder is in the folder of ShipWarden, but git does not know it. It is from an old checkout.
                await this.git(source, ['worktree', 'prune']).catch(() => undefined);
                await fs.rm(root, { recursive: true, force: true });
            }
            await fs.mkdir(path.dirname(root), { recursive: true });
            await this.git(source, ['worktree', 'add', '--quiet', '--detach', root, sha]);
        });

        await this.index.update(file => {
            this.entries(file)[key] = { owner: repo.owner, name: repo.name, number, root, repoPath: source, sha, usedAt: this.now() };
        });
        return { root, sha };
    }

    private async clone(repo: RepoRef): Promise<string> {
        const target = this.clonePath(repo);
        return this.queue(target, async () => {
            if (await this.exists(path.join(target, '.git'))) return target;
            await fs.rm(target, { recursive: true, force: true });
            await fs.mkdir(path.dirname(target), { recursive: true });
            const url = `https://github.com/${repo.owner}/${repo.name}.git`;
            try {
                // --filter=blob:none: git gets the file contents only for the commits that a checkout needs.
                await this.git(path.dirname(target), ['clone', '--quiet', '--no-checkout', '--filter=blob:none', url, target], { timeout: CLONE_TIMEOUT_MS });
            } catch (error) {
                await fs.rm(target, { recursive: true, force: true });
                throw error;
            }
            return target;
        });
    }

    private async removeWorktree(entry: IndexEntry): Promise<void> {
        if (await this.exists(entry.repoPath)) {
            await this.git(entry.repoPath, ['worktree', 'remove', '--force', entry.root]).catch(() => undefined);
            await this.git(entry.repoPath, ['worktree', 'prune']).catch(() => undefined);
        }
        // Only a folder in the folder of ShipWarden goes away. The index can have an old or changed path.
        if (this.isInFolder(entry.root)) {
            await fs.rm(entry.root, { recursive: true, force: true });
        }
    }

    private queue<T>(key: string, work: () => Promise<T>): Promise<T> {
        const before = this.repoQueues.get(key) ?? Promise.resolve();
        const next = before.catch(() => undefined).then(work);
        const settled = next.catch(() => undefined);
        this.repoQueues.set(key, settled);
        void settled.then(() => {
            if (this.repoQueues.get(key) === settled) this.repoQueues.delete(key);
        });
        return next;
    }

    private async hasCommit(repoPath: string, sha: string): Promise<boolean> {
        try {
            await this.git(repoPath, ['cat-file', '-e', `${sha}^{commit}`]);
            return true;
        } catch {
            return false;
        }
    }

    private async isWorktreeOf(repoPath: string, root: string): Promise<boolean> {
        if (!(await this.exists(root))) return false;
        try {
            const output = await this.git(repoPath, ['worktree', 'list', '--porcelain']);
            const wanted = await this.realpath(root);
            for (const line of output.split('\n')) {
                if (line.startsWith('worktree ') && (await this.realpath(line.slice('worktree '.length))) === wanted) return true;
            }
            return false;
        } catch {
            return false;
        }
    }

    private checkoutPath(repo: RepoRef, number: number): string {
        return path.join(this.options.folder, repo.owner.toLowerCase(), repo.name.toLowerCase(), `pr-${number}`);
    }

    private clonePath(repo: Pick<RepoRef, 'owner' | 'name'>): string {
        return path.join(this.options.folder, repo.owner.toLowerCase(), repo.name.toLowerCase(), 'repo');
    }

    /** Returns the checkouts of the index. An index file that is not correct gives an empty object. */
    private entries(file: IndexFile): Record<string, IndexEntry> {
        if (!file.checkouts || typeof file.checkouts !== 'object' || Array.isArray(file.checkouts)) file.checkouts = {};
        return file.checkouts;
    }

    private async exists(target: string): Promise<boolean> {
        try {
            await fs.access(target);
            return true;
        } catch {
            return false;
        }
    }

    private async realpath(target: string): Promise<string> {
        try {
            return await fs.realpath(target);
        } catch {
            return path.resolve(target);
        }
    }
}
