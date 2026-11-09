import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { GRAPH_LOG_FORMAT, parseGraphLog, type GraphLog, type GraphScope } from '@shared/git-graph';
import { changePathError, parseStatus, type ChangeContents, type ChangeSide, type CommitResult, type FetchResult, type GitChanges } from '@shared/git';

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
    /** The last fetch of each repository, by its common git folder. The worktrees of a repository share it. */
    private readonly fetches = new Map<string, FetchResult & { running?: Promise<FetchResult> }>();

    /** `trash` moves a file or a folder to the Trash. The tests replace it. */
    constructor(private readonly trash: (file: string) => Promise<void>) {}

    /**
     * Fetches the remote of the upstream branch, so the status knows the commits to pull. It does nothing when the
     * last fetch of the repository is newer than `maxAgeMs`, or when the branch has no upstream. Git does not ask
     * for a password: a fetch that needs one fails, and the result has the error.
     */
    async fetch(worktree: string, maxAgeMs: number): Promise<FetchResult> {
        const status = await this.status(worktree);
        if (!status.upstream) return {};
        const remote = status.upstream.split('/')[0];
        const commonDir = path.resolve(worktree, ((await run(worktree, ['rev-parse', '--git-common-dir'])) ?? '.git').trim());
        const last = this.fetches.get(commonDir);
        if (last?.running) return last.running;
        if (last?.at && Date.now() - last.at < maxAgeMs) return { at: last.at, error: last.error };
        const running = run(worktree, ['fetch', '--quiet', '--prune', remote], { timeout: 60_000 }).then(
            (): FetchResult => ({ at: Date.now() }),
            (error): FetchResult => ({ at: Date.now(), error: error instanceof Error ? error.message : String(error) })
        );
        this.fetches.set(commonDir, { ...last, running });
        const result = await running;
        this.fetches.set(commonDir, result);
        return result;
    }

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
    /**
     * Returns the newest commits for the graph, children before parents. Scope "all" shows the local branches, the
     * remote branches, the tags and HEAD. Scope "head" shows only the history of HEAD. A repository without commits
     * gives an empty list.
     */
    async log(worktree: string, scope: GraphScope, limit: number): Promise<GraphLog> {
        const count = Math.max(1, Math.min(Math.floor(limit), 5000));
        const refs = scope === 'all' ? ['--branches', '--remotes', '--tags', 'HEAD'] : ['HEAD'];
        // One more commit than the limit tells if there are more.
        const output = await run(worktree, ['log', '--topo-order', '--decorate=full', `--format=${GRAPH_LOG_FORMAT}`, `--max-count=${count + 1}`, ...refs, '--'], { allowFailure: true });
        if (output === undefined) {
            const head = await run(worktree, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true });
            if (head === undefined) return { commits: [], more: false };
            throw new Error('git log failed for the graph.');
        }
        const commits = parseGraphLog(output);
        return { commits: commits.slice(0, count), more: commits.length > count };
    }

    async lastMessage(worktree: string): Promise<string> {
        return ((await run(worktree, ['log', '-1', '--format=%B'], { allowFailure: true })) ?? '').trimEnd();
    }

    /**
     * Discards the unstaged changes of files, so they get the version of the index again. An untracked file goes to
     * the Trash. For a changed file, a copy of the working version goes to the Trash first, so the user can get it
     * back. A file with a merge conflict is refused.
     */
    async discard(worktree: string, paths: string[]): Promise<void> {
        const list = checkPaths(paths);
        if (!list.length) return;
        const status = await this.status(worktree);
        const conflicted = list.filter(item => status.conflicted.some(change => change.path === item));
        if (conflicted.length) throw new Error(`Resolve the merge conflict first: ${conflicted.join(', ')}.`);
        const untracked = list.filter(item => status.unstaged.some(change => change.path === item && change.kind === 'untracked'));
        const tracked = list.filter(item => status.unstaged.some(change => change.path === item && change.kind !== 'untracked'));

        for (const item of untracked) {
            await this.trash(path.join(worktree, item));
        }
        if (!tracked.length) return;
        // Keep a copy of each working version that the restore replaces.
        const backup = await fs.mkdtemp(path.join(tmpdir(), 'shipwarden-discarded-'));
        try {
            for (const item of tracked) {
                const source = path.join(worktree, item);
                const stat = await fs.stat(source).catch(() => undefined);
                if (!stat?.isFile()) continue;
                const copy = path.join(backup, `${path.basename(item, path.extname(item))} (discarded ${new Date().toISOString().slice(0, 19).replace(/:/g, '-')})${path.extname(item)}`);
                await fs.copyFile(source, copy);
                await this.trash(copy);
            }
            await run(worktree, ['restore', '--worktree', '--', ...tracked]);
        } finally {
            await fs.rm(backup, { recursive: true, force: true });
        }
    }

    /**
     * Pulls the upstream branch with a fast-forward only. It makes no merge commit. When the branch and the upstream
     * both have new commits, git refuses, and the error says so.
     */
    async pull(worktree: string): Promise<void> {
        const changes = await this.status(worktree);
        if (!changes.upstream) throw new Error('The branch has no upstream branch. Push it first.');
        try {
            await run(worktree, ['pull', '--ff-only'], { timeout: 180_000 });
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            if (/Not possible to fast-forward|diverging|divergent/i.test(text)) {
                throw new Error('Your branch and the upstream branch both have new commits. Merge or rebase in a terminal.');
            }
            throw error;
        }
    }

    /** Pushes the branch. A branch without an upstream gets "origin" as its upstream. */
    async push(worktree: string): Promise<void> {
        const changes = await this.status(worktree);
        if (!changes.branch) throw new Error('The worktree has no branch (a detached HEAD). Make a branch first.');
        const args = changes.upstream ? ['push'] : ['push', '-u', 'origin', changes.branch];
        await run(worktree, args, { timeout: 180_000 });
    }
}

