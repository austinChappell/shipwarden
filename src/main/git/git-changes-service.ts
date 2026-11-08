import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { changePathError, parseStatus, type ChangeContents, type ChangeSide, type CommitResult, type GitChanges } from '@shared/git';

/** Files larger than this do not show in a diff. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/** Git must never wait for a password on a terminal that does not exist. */
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

interface RunOptions {
    input?: string;
    /** Returns undefined instead of an error when git fails. */
    allowFailure?: boolean;
    timeout?: number;
}

function run(cwd: string, args: string[], options: RunOptions = {}): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd, env: GIT_ENV });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let size = 0;
        const timer = options.timeout ? setTimeout(() => child.kill(), options.timeout) : undefined;
        child.stdout.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size <= 64 * 1024 * 1024) out.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
        child.on('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', code => {
            clearTimeout(timer);
            if (code === 0) {
                resolve(Buffer.concat(out).toString('utf8'));
            } else if (options.allowFailure) {
                resolve(undefined);
            } else {
                const detail = Buffer.concat(err).toString('utf8').trim() || `exit code ${code}`;
                reject(new Error(`git ${args[0]} failed: ${detail}`));
            }
        });
        if (options.input !== undefined) child.stdin.end(options.input);
        else child.stdin.end();
    });
}

function checkPaths(paths: string[]): string[] {
    const list = paths.map(String);
    for (const item of list) {
        const error = changePathError(item);
        if (error) throw new Error(error);
    }
    return list;
}

const isBinary = (text: string) => text.slice(0, 8000).includes('\0');

/**
 * The local changes of a worktree: the git status, staging, the two versions of a changed file, commit and push.
 * Each method runs git in the worktree folder.
 */
export class GitChangesService {
    async status(worktree: string): Promise<GitChanges> {
        const output = await run(worktree, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
        return parseStatus(output ?? '');
    }

    /** Adds files to the index. A deleted file is staged as deleted. */
    async stage(worktree: string, paths: string[]): Promise<void> {
        const list = checkPaths(paths);
        if (list.length) await run(worktree, ['add', '-A', '--', ...list]);
    }

    /** Removes the changes of files from the index. The working files do not change. */
    async unstage(worktree: string, paths: string[]): Promise<void> {
        const list = checkPaths(paths);
        if (!list.length) return;
        const hasHead = await run(worktree, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true });
        // Before the first commit, there is no HEAD to restore from.
        if (hasHead) await run(worktree, ['restore', '--staged', '--', ...list]);
        else await run(worktree, ['rm', '--cached', '-r', '-q', '--', ...list]);
    }

    /**
     * The two versions of a changed file. Staged: the version of HEAD and the version of the index.
     * Unstaged: the version of the index and the working file. A missing version is empty.
     */
    async contents(worktree: string, filePath: string, side: ChangeSide, oldPath?: string): Promise<ChangeContents> {
        const [file] = checkPaths([filePath]);
        const before = oldPath ? checkPaths([oldPath])[0] : file;
        const show = async (spec: string) => (await run(worktree, ['show', spec], { allowFailure: true })) ?? '';
        let original: string;
        let modified: string;
        if (side === 'staged') {
            original = await show(`HEAD:${before}`);
            modified = await show(`:${file}`);
        } else {
            original = await show(`:${file}`);
            modified = await this.readWorking(worktree, file);
        }
        if (isBinary(original) || isBinary(modified)) return { original: '', modified: '', binary: true };
        return { original, modified, binary: false };
    }

    private async readWorking(worktree: string, file: string): Promise<string> {
        const full = path.join(worktree, file);
        try {
            const stat = await fs.stat(full);
            if (!stat.isFile()) return '';
            if (stat.size > MAX_DIFF_BYTES) throw new Error(`The file is larger than ${MAX_DIFF_BYTES / 1024 / 1024} MB.`);
            return await fs.readFile(full, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
            throw error;
        }
    }

    /** Commits the index with the message. With `amend`, the commit replaces the last commit. The hooks of the repository run. */
    async commit(worktree: string, message: string, amend = false): Promise<CommitResult> {
        if (!message.trim()) throw new Error('Type a commit message.');
        await run(worktree, ['commit', '-F', '-', ...(amend ? ['--amend'] : [])], { input: message, timeout: 120_000 });
        const log = (await run(worktree, ['log', '-1', '--format=%h%x00%s'])) ?? '';
        const [hash, summary] = log.trim().split('\0');
        return { hash, summary: summary ?? '' };
    }

    /** The message of the last commit, for "Amend". */
    async lastMessage(worktree: string): Promise<string> {
        return ((await run(worktree, ['log', '-1', '--format=%B'], { allowFailure: true })) ?? '').trimEnd();
    }

    /** Pushes the branch. A branch without an upstream gets "origin" as its upstream. */
    async push(worktree: string): Promise<void> {
        const changes = await this.status(worktree);
        if (!changes.branch) throw new Error('The worktree has no branch (a detached HEAD). Make a branch first.');
        const args = changes.upstream ? ['push'] : ['push', '-u', 'origin', changes.branch];
        await run(worktree, args, { timeout: 180_000 });
    }
}

