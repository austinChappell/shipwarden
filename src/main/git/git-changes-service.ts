import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { GRAPH_LOG_FORMAT, parseGraphLog, type GraphLog, type GraphScope } from '@shared/git-graph';
import { PULL_REQUEST_TEMPLATE_PATHS, type CommitDraftInput, type PullRequestDraftInput } from '@shared/drafts';
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

/** The number of recent commit subjects that a commit message draft gets, for the style of the repository. */
const RECENT_SUBJECTS = 15;
/** The most commits of a branch that a pull request draft gets. */
const MAX_DRAFT_COMMITS = 100;
/** The longest pull request template that a draft gets. */
const MAX_TEMPLATE = 20_000;

/** Finds an entry in a folder. The match ignores case. Returns the real name, or undefined. */
async function findEntry(folder: string, name: string): Promise<string | undefined> {
    try {
        const entries = await fs.readdir(folder);
        return entries.find(entry => entry === name) ?? entries.find(entry => entry.toLowerCase() === name.toLowerCase());
    } catch {
        return undefined;
    }
}

/** Finds a path from the root. Each part of the path ignores case. Returns the real path from the root, or undefined. */
async function findPath(root: string, relative: string): Promise<string | undefined> {
    let found = '';
    for (const part of relative.split('/').filter(Boolean)) {
        const entry = await findEntry(path.join(root, found), part);
        if (!entry) return undefined;
        found = found ? `${found}/${entry}` : entry;
    }
    return found || undefined;
}

/**
 * Finds the pull request template of a worktree in the places of `PULL_REQUEST_TEMPLATE_PATHS`.
 * For a folder of templates, the first Markdown file by name applies. Returns undefined when there is no template.
 */
export async function findPullRequestTemplate(worktree: string): Promise<{ path: string; text: string } | undefined> {
    for (const candidate of PULL_REQUEST_TEMPLATE_PATHS) {
        const found = await findPath(worktree, candidate);
        if (!found) continue;
        let file = found;
        if (candidate.endsWith('/')) {
            const entries = await fs.readdir(path.join(worktree, found)).catch(() => [] as string[]);
            const first = entries.filter(entry => entry.toLowerCase().endsWith('.md')).sort()[0];
            if (!first) continue;
            file = `${found}/${first}`;
        }
        try {
            const text = (await fs.readFile(path.join(worktree, file), 'utf8')).slice(0, MAX_TEMPLATE).trim();
            if (text) return { path: file, text };
        } catch {
            // The entry is a folder or cannot be read. Try the next place.
        }
    }
    return undefined;
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

    /**
     * Returns the newest commits for the graph, children before parents. Scope "all" shows the local branches, the
     * remote branches, the tags and HEAD. Scope "local" does not show the remote branches. A repository without
     * commits gives an empty list.
     */
    async log(worktree: string, scope: GraphScope, limit: number): Promise<GraphLog> {
        const count = Math.max(1, Math.min(Math.floor(limit), 5000));
        const refs = scope === 'all' ? ['--branches', '--remotes', '--tags', 'HEAD'] : ['--branches', '--tags', 'HEAD'];
        // One more commit than the limit tells if there are more.
        const output = await run(
            worktree,
            ['log', '--topo-order', '--decorate=full', `--format=${GRAPH_LOG_FORMAT}`, `--max-count=${count + 1}`, ...refs, '--'],
            { allowFailure: true }
        );
        if (output === undefined) {
            const head = await run(worktree, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true });
            if (head === undefined) return { commits: [], more: false };
            throw new Error('git log failed for the graph.');
        }
        const commits = parseGraphLog(output);
        return { commits: commits.slice(0, count), more: commits.length > count };
    }

    /** The message of the last commit, for "Amend". */
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
                const copy = path.join(
                    backup,
                    `${path.basename(item, path.extname(item))} (discarded ${new Date().toISOString().slice(0, 19).replace(/:/g, '-')})${path.extname(item)}`
                );
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

    /**
     * Returns the git data of a commit message draft: the staged diff and the recent commit subjects.
     * With `amend`, the diff goes from the parent of HEAD to the index, so it includes the changes of the last commit.
     * Throws when there is nothing to commit.
     */
    async commitDraftInput(worktree: string, amend: boolean): Promise<Omit<CommitDraftInput, 'settings'>> {
        const hasHead = (await run(worktree, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true })) !== undefined;
        const hasParent = hasHead && (await run(worktree, ['rev-parse', '--verify', '-q', 'HEAD^'], { allowFailure: true })) !== undefined;
        // An amend of the first commit compares with the empty tree.
        const emptyTree = ((await run(worktree, ['hash-object', '-t', 'tree', '/dev/null'])) ?? '').trim();
        const from = amend && hasHead ? [hasParent ? 'HEAD^' : emptyTree] : [];
        const diff = (await run(worktree, ['diff', '--cached', '--no-color', '--no-ext-diff', ...from])) ?? '';
        if (!diff.trim()) throw new Error(amend ? 'The amended commit has no changes.' : 'Stage changes first. The draft describes the staged changes.');
        const stat = (await run(worktree, ['diff', '--cached', '--stat', '--no-color', ...from])) ?? '';
        const subjects = hasHead ? ((await run(worktree, ['log', `--max-count=${RECENT_SUBJECTS}`, '--format=%s'], { allowFailure: true })) ?? '') : '';
        const branch = (await run(worktree, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true }))?.trim();
        return {
            ...(branch ? { branch } : {}),
            stat,
            diff,
            recentSubjects: subjects.split('\n').filter(Boolean),
            ...(amend && hasHead ? { amendedMessage: await this.lastMessage(worktree) } : {})
        };
    }

    /**
     * Returns the git data of a pull request description draft: the commits and the diff of the branch since it left
     * the default branch of "origin", and the pull request template of the repository.
     */
    async pullRequestDraftInput(worktree: string): Promise<Omit<PullRequestDraftInput, 'settings'>> {
        const branch = (await run(worktree, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true }))?.trim();
        if (!branch) throw new Error('The worktree has no branch (a detached HEAD).');
        const base = await this.defaultRemoteBranch(worktree);
        if (!base) throw new Error('ShipWarden cannot find the default branch of "origin". Fetch the remote and try again.');
        const range = `${base}...HEAD`;
        const diff = (await run(worktree, ['diff', '--no-color', '--no-ext-diff', range])) ?? '';
        if (!diff.trim()) throw new Error(`The branch has no changes from ${base}. Commit changes first.`);
        const stat = (await run(worktree, ['diff', '--stat', '--no-color', range])) ?? '';
        const log = (await run(worktree, ['log', '--reverse', `--max-count=${MAX_DRAFT_COMMITS}`, '--format=%B%x00', `${base}..HEAD`])) ?? '';
        const commits = log
            .split('\0')
            .map(message => message.trim())
            .filter(Boolean);
        const template = await findPullRequestTemplate(worktree);
        return { branch, base, commits, stat, diff, ...(template ? { template } : {}) };
    }

    /** Returns the default branch of "origin", for example "origin/main", or undefined when it is not known. */
    private async defaultRemoteBranch(worktree: string): Promise<string | undefined> {
        const head = (await run(worktree, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], { allowFailure: true }))?.trim();
        for (const candidate of [head, 'origin/main', 'origin/master']) {
            if (candidate && (await run(worktree, ['rev-parse', '--verify', '-q', `${candidate}^{commit}`], { allowFailure: true })) !== undefined) {
                return candidate;
            }
        }
        return undefined;
    }

    /** Pushes the branch. A branch without an upstream gets "origin" as its upstream. */
    async push(worktree: string): Promise<void> {
        const changes = await this.status(worktree);
        if (!changes.branch) throw new Error('The worktree has no branch (a detached HEAD). Make a branch first.');
        const args = changes.upstream ? ['push'] : ['push', '-u', 'origin', changes.branch];
        await run(worktree, args, { timeout: 180_000 });
    }
}
