import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cloneUrl, type RepoRef } from '@shared/github';
import { isSafeRepoName } from '@shared/review-checkout';
import { sameRepo } from './ipc/args';

/** The time limit for a clone. A large repository needs time. */
const CLONE_TIMEOUT_MS = 15 * 60_000;

export interface CloneRepoOptions {
    /** Returns the GitHub or Azure Repos repository of the "origin" remote of a folder, or null. */
    repoFor(root: string): Promise<RepoRef | null>;
    /** Returns the URL to clone. The default is the HTTPS URL on the host. Tests use a local folder. */
    cloneUrl?(repo: RepoRef): string;
}

/** Returns the absolute path of a folder. A leading "~" is the home folder. */
export function expandHome(folder: string, home = os.homedir()): string {
    if (folder === '~') return home;
    return folder.startsWith('~/') ? path.join(home, folder.slice(2)) : folder;
}

/**
 * Clones a GitHub or Azure Repos repository to <parent>/<name> for a project. It is a full clone with a checkout of the default branch.
 * When the folder is a clone of the same repository, the function uses it and does not clone.
 * Returns the folder of the clone.
 * Throws an error when the folder exists and is not a clone of the repository, or when git fails.
 */
export async function cloneRepo(parent: string, repo: RepoRef, options: CloneRepoOptions): Promise<string> {
    if (!isSafeRepoName(repo)) {
        throw new Error(`"${repo.name}" is not a valid repository name.`);
    }
    const target = path.join(parent, repo.name);
    if (await exists(target)) {
        const ref = await options.repoFor(target).catch(() => null);
        if (ref && sameRepo(ref, repo)) {
            return target;
        }
        throw new Error(`The folder "${target}" exists and is not a clone of ${repo.owner}/${repo.name}. Choose a different folder.`);
    }
    const url = options.cloneUrl?.(repo) ?? cloneUrl(repo);
    try {
        await gitClone(parent, url, target);
    } catch (error) {
        // A failed clone can leave a part of the folder. The next try must start from an empty folder.
        await fs.rm(target, { recursive: true, force: true });
        throw error;
    }
    return target;
}

/** Runs `git clone`. Git must not ask for a password, because no terminal shows. */
function gitClone(cwd: string, url: string, target: string): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(
            'git',
            ['clone', '--quiet', url, target],
            { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: CLONE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
            (error, _stdout, stderr) => {
                if (error) {
                    reject(new Error(`git clone failed: ${(stderr || error.message).trim()}`));
                } else {
                    resolve();
                }
            }
        );
    });
}

async function exists(target: string): Promise<boolean> {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}
