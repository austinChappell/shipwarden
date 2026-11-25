import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { FILE_HISTORY_FORMAT, parseBlamePorcelain, parseFileHistory, type FileBlame, type FileHistory } from '@shared/git-blame';
import { GRAPH_LOG_FORMAT, parseGraphLog, type GraphLog, type GraphScope } from '@shared/git-graph';
import { PULL_REQUEST_TEMPLATE_PATHS, type CommitDraftInput, type PullRequestDraftInput } from '@shared/drafts';
import {
    changePathError,
    parseNumstat,
    parseStatus,
    type BranchDiff,
    type BranchFileStat,
    type ChangeContents,
    type ChangeSide,
    type CommitResult,
    type FetchResult,
    type GitChanges,
    hasUncommittedChanges,
    type RebaseConflictInput,
    type RebaseResult,
    type RebaseState
} from '@shared/git';
import { worktreeFileList, type WorktreeFiles } from '@shared/worktree-overlap';
import type { Worktree } from '@shared/worktrees';

/** Files larger than this do not show in a diff. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
/** The branch diff reads at most this number of untracked files to count their lines. */
const MAX_UNTRACKED_COUNTS = 1000;

/**
 * Git must never wait for a password on a terminal that does not exist. Git must never open an editor that nobody sees.
 * "true" as the editor keeps the message, for example of a commit in "git rebase --continue".
 */
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' };

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

/** The most entries of the cache of committed files. The cache starts again when it is full. */
const MAX_COMMITTED_CACHE = 500;
/** A full or short commit hash. */
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;

/** True when `ancestor` is an ancestor of `commit`, or the same commit. */
async function isAncestor(worktree: string, ancestor: string, commit: string): Promise<boolean> {
    return (await run(worktree, ['merge-base', '--is-ancestor', ancestor, commit], { allowFailure: true })) !== undefined;
}

/** The most commits of each side that the data of a rebase conflict gets. */
const MAX_CONFLICT_COMMITS = 30;

/** Reads a file of the rebase folder. Returns undefined when the file does not exist. */
async function readRebaseFile(folder: string, name: string): Promise<string | undefined> {
    try {
        return (await fs.readFile(path.join(folder, name), 'utf8')).trim();
    } catch {
        return undefined;
    }
}

/** Returns a positive whole number from the text, or undefined. */
function countOf(text: string | undefined): number | undefined {
    const value = Number(text);
    return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The local changes of a worktree: the git status, staging, the two versions of a changed file, commit and push.
 * Each method runs git in the worktree folder.
 */
export class GitChangesService {
    /** The last fetch of each repository, by its common git folder. The worktrees of a repository share it. */
    private readonly fetches = new Map<string, FetchResult & { running?: Promise<FetchResult> }>();

    /**
     * The files of the commits of a branch since the merge base with the default branch, by "<base commit>...<HEAD>".
     * The files of a pair of commits do not change, so git runs again only after a new commit or a new base.
     */
    private readonly committedFiles = new Map<string, string[]>();

    /** The git folder of each worktree, for the check of a rebase in each status. */
    private readonly gitDirs = new Map<string, string>();

    /**
     * The commit of the upstream branch at the start of a rebase in ShipWarden, by "<worktree>\0<branch>". The push
     * after the rebase replaces the remote branch only when it is still at this commit.
     */
    private readonly leases = new Map<string, string>();

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
        const commonDir = await this.commonDir(worktree);
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

    /** The common git folder of the repository of a worktree. The worktrees of a repository share it. */
    private async commonDir(worktree: string): Promise<string> {
        return path.resolve(worktree, ((await run(worktree, ['rev-parse', '--git-common-dir'])) ?? '.git').trim());
    }

    async status(worktree: string): Promise<GitChanges> {
        const output = await run(worktree, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
        const changes = parseStatus(output ?? '');
        const rebase = await this.rebaseState(worktree);
        return rebase ? { ...changes, rebase } : changes;
    }

    /** The git folder of the worktree. Each linked worktree has its own. */
    private async gitDir(worktree: string): Promise<string> {
        const known = this.gitDirs.get(worktree);
        // A worktree that was removed and made again at the same path can have a different git folder.
        if (
            known &&
            (await fs.stat(known).then(
                () => true,
                () => false
            ))
        )
            return known;
        const dir = path.resolve(worktree, ((await run(worktree, ['rev-parse', '--git-dir'])) ?? '.git').trim());
        this.gitDirs.set(worktree, dir);
        return dir;
    }

    /** The rebase folder of git and its kind, or undefined when no rebase is in progress. "git am" does not count. */
    private async rebaseFolder(worktree: string): Promise<string | undefined> {
        const dir = await this.gitDir(worktree);
        const merge = path.join(dir, 'rebase-merge');
        if (
            await fs.stat(merge).then(
                stat => stat.isDirectory(),
                () => false
            )
        )
            return merge;
        const apply = path.join(dir, 'rebase-apply');
        if (
            await fs.stat(path.join(apply, 'rebasing')).then(
                () => true,
                () => false
            )
        )
            return apply;
        return undefined;
    }

    /**
     * Returns the rebase that is in progress in the worktree, or undefined. It reads the rebase folder of git, so it also
     * finds a rebase that started in a terminal.
     */
    async rebaseState(worktree: string): Promise<RebaseState | undefined> {
        const folder = await this.rebaseFolder(worktree);
        if (!folder) return undefined;
        const merge = path.basename(folder) === 'rebase-merge';
        const [headName, onto, step, total] = await Promise.all([
            readRebaseFile(folder, 'head-name'),
            readRebaseFile(folder, 'onto'),
            readRebaseFile(folder, merge ? 'msgnum' : 'next'),
            readRebaseFile(folder, merge ? 'end' : 'last')
        ]);
        if (!onto) return undefined;
        const branch = headName?.startsWith('refs/heads/') ? headName.slice('refs/heads/'.length) : undefined;
        const names = await run(worktree, ['for-each-ref', '--points-at', onto, '--format=%(refname:short)', 'refs/remotes', 'refs/heads'], {
            allowFailure: true
        });
        const ontoName = (names ?? '')
            .split('\n')
            .map(name => name.trim())
            .filter(name => name && !name.endsWith('/HEAD'))
            .sort((a, b) => Number(b.startsWith('origin/')) - Number(a.startsWith('origin/')))[0];
        const stoppedLine = await run(worktree, ['log', '-1', '--format=%h%x00%s', 'REBASE_HEAD', '--'], { allowFailure: true });
        const [hash, subject] = (stoppedLine ?? '').trim().split('\0');
        return {
            ...(branch ? { branch } : {}),
            onto,
            ...(ontoName ? { ontoName } : {}),
            ...(countOf(step) ? { step: countOf(step) } : {}),
            ...(countOf(total) ? { total: countOf(total) } : {}),
            ...(hash ? { stopped: { hash, subject: subject ?? '' } } : {})
        };
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

    /**
     * Returns the changes of the branch since its base: the commits, the staged and unstaged changes, and the
     * untracked files. The base is the merge base with the default branch of "origin". Without it, the base is HEAD.
     */
    async branchDiff(worktree: string): Promise<BranchDiff> {
        const base = await this.branchBase(worktree);
        const from = base ?? ((await run(worktree, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true })) ? 'HEAD' : undefined);
        const tracked = from ? parseNumstat((await run(worktree, ['diff', '--numstat', '-z', '-M', '--no-color', '--no-ext-diff', from, '--'])) ?? '') : [];
        const untrackedOutput = (await run(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])) ?? '';
        const untracked: BranchFileStat[] = [];
        for (const file of untrackedOutput.split('\0').filter(Boolean).slice(0, MAX_UNTRACKED_COUNTS)) {
            untracked.push({ path: file, ...(await this.countLines(worktree, file)), removed: 0, untracked: true });
        }
        return { ...(base ? { base } : {}), files: [...tracked, ...untracked] };
    }

    /**
     * The two versions of a file for the branch diff: the version of the base commit and the working file.
     * `base` is the value of `branchDiff`. Without it, the first version comes from HEAD.
     */
    async branchContents(worktree: string, filePath: string, base: string | undefined, oldPath?: string): Promise<ChangeContents> {
        const [file] = checkPaths([filePath]);
        const before = oldPath ? checkPaths([oldPath])[0] : file;
        if (base !== undefined && !/^[0-9a-f]{7,64}$/i.test(base)) throw new Error('The base must be a commit hash.');
        const original = (await run(worktree, ['show', `${base ?? 'HEAD'}:${before}`], { allowFailure: true })) ?? '';
        const modified = await this.readWorking(worktree, file);
        if (isBinary(original) || isBinary(modified)) return { original: '', modified: '', binary: true };
        return { original, modified, binary: false };
    }

    /**
     * Returns the last commit that changed each line of a file. With `contents`, git blames that text instead of the
     * working file, so the lines match an editor with changes that are not saved. The lines that are not in a commit
     * get `UNCOMMITTED_HASH`. Returns null when git does not know the file, for example an untracked file.
     */
    async blame(worktree: string, filePath: string, contents?: string): Promise<FileBlame | null> {
        const [file] = checkPaths([filePath]);
        if (contents !== undefined && contents.length > MAX_DIFF_BYTES) return null;
        const args = ['blame', '--porcelain', ...(contents !== undefined ? ['--contents', '-'] : []), '--', file];
        const output = await run(worktree, args, { allowFailure: true, input: contents, timeout: 30_000 });
        return output === undefined ? null : parseBlamePorcelain(output);
    }

    /**
     * Returns the commits that changed a file, newest first, at most `limit`. The history follows the renames of the file.
     * A file that git does not know has no commits.
     */
    async fileHistory(worktree: string, filePath: string, limit: number): Promise<FileHistory> {
        const [file] = checkPaths([filePath]);
        const count = Math.max(1, Math.min(Math.floor(limit), 2000));
        // One more commit than the limit tells if there are more.
        const output = await run(
            worktree,
            ['log', '--follow', '-M', '--name-status', '-z', `--format=${FILE_HISTORY_FORMAT}`, `--max-count=${count + 1}`, 'HEAD', '--', file],
            { allowFailure: true, timeout: 30_000 }
        );
        const commits = output === undefined ? [] : parseFileHistory(output);
        return { commits: commits.slice(0, count), more: commits.length > count };
    }

    /**
     * Returns the change of one commit to a file: the version in the first parent and the version in the commit.
     * `oldPath` is the path in the parent, when the commit renamed the file. A missing version is empty.
     */
    async commitFileContents(worktree: string, commit: string, filePath: string, oldPath?: string): Promise<ChangeContents> {
        const [file] = checkPaths([filePath]);
        const before = oldPath ? checkPaths([oldPath])[0] : file;
        if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw new Error('The commit must be a commit hash.');
        const show = async (spec: string) => (await run(worktree, ['show', spec], { allowFailure: true })) ?? '';
        const [original, modified] = await Promise.all([show(`${commit}^:${before}`), show(`${commit}:${file}`)]);
        if (isBinary(original) || isBinary(modified)) return { original: '', modified: '', binary: true };
        return { original, modified, binary: false };
    }

    /** The merge base of HEAD and the default branch of "origin", or undefined when it is not known. */
    private async branchBase(worktree: string): Promise<string | undefined> {
        const remote = await this.defaultRemoteBranch(worktree);
        if (!remote) return undefined;
        return (await run(worktree, ['merge-base', 'HEAD', remote], { allowFailure: true }))?.trim() || undefined;
    }

    /** Counts the lines of a new file. A binary file or a file larger than the diff limit counts as binary. */
    private async countLines(worktree: string, file: string): Promise<{ added: number; binary: boolean }> {
        try {
            const text = await this.readWorking(worktree, file);
            if (isBinary(text)) return { added: 0, binary: true };
            if (!text) return { added: 0, binary: false };
            return { added: text.split('\n').length - (text.endsWith('\n') ? 1 : 0), binary: false };
        } catch {
            return { added: 0, binary: true };
        }
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

    /**
     * Returns the changed files of each linked worktree of a repository, for the overlap warning. The main worktree,
     * a bare worktree and a prunable worktree do not count. The files are the files of the commits since the merge base
     * with the default branch, and the files of the git status. When fewer than two worktrees count, no overlap is
     * possible, and git does not run. A worktree that git cannot read is not in the result.
     */
    async worktreeFiles(repo: string, worktrees: readonly Worktree[]): Promise<WorktreeFiles[]> {
        const candidates = worktrees.filter(worktree => !worktree.isMain && !worktree.isBare && !worktree.prunable && worktree.head);
        if (candidates.length < 2) return [];
        const base = await this.baseBranch(repo);
        const baseSha = base ? (await run(repo, ['rev-parse', '--verify', '-q', `${base}^{commit}`], { allowFailure: true }))?.trim() : undefined;
        const results = await Promise.all(
            candidates.map(async (worktree): Promise<WorktreeFiles | undefined> => {
                try {
                    const committed = baseSha ? await this.committed(repo, baseSha, worktree.head) : [];
                    const status = await this.status(worktree.path);
                    return {
                        path: worktree.path,
                        ...(worktree.branch ? { branch: worktree.branch } : {}),
                        files: worktreeFileList(committed, status)
                    };
                } catch {
                    return undefined;
                }
            })
        );
        return results.filter((item): item is WorktreeFiles => !!item);
    }

    /** Returns the files of the commits from the merge base of the two commits to `head`. The cache keeps the result. */
    private async committed(repo: string, baseSha: string, head: string): Promise<string[]> {
        const key = `${baseSha}...${head}`;
        const cached = this.committedFiles.get(key);
        if (cached) return cached;
        // --no-renames gives the old path and the new path of a rename. A change to either path can conflict.
        const output = await run(repo, ['diff', '--name-only', '--no-renames', '-z', key], { allowFailure: true });
        const files = (output ?? '').split('\0').filter(Boolean);
        if (this.committedFiles.size >= MAX_COMMITTED_CACHE) this.committedFiles.clear();
        if (output !== undefined) this.committedFiles.set(key, files);
        return files;
    }

    /**
     * Returns the default branch for the overlap: the default branch of "origin", else a local "main" or "master".
     * Returns undefined when none exists.
     */
    private async baseBranch(repo: string): Promise<string | undefined> {
        const remote = await this.defaultRemoteBranch(repo);
        if (remote) return remote;
        for (const candidate of ['main', 'master']) {
            if ((await run(repo, ['rev-parse', '--verify', '-q', `refs/heads/${candidate}^{commit}`], { allowFailure: true })) !== undefined) {
                return candidate;
            }
        }
        return undefined;
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

    /**
     * Returns the branch that "Rebase onto" uses: the default branch of "origin" without the remote, for example "main".
     * Returns undefined when it is not known. It runs local git only.
     */
    async defaultBranch(worktree: string): Promise<string | undefined> {
        return (await this.defaultRemoteBranch(worktree))?.replace(/^origin\//, '');
    }

    /**
     * Fetches "origin" and rebases the branch onto "origin/<onto>". Without `onto`, the target is the default branch of
     * "origin". When a commit has a conflict, the rebase stops and the result has the state. The rebase never pushes.
     *
     * It refuses to start when a rebase is in progress, when the worktree has uncommitted changes (it does not stash
     * them), when HEAD is detached, and when the branch only lacks commits of its upstream (then a pull is correct).
     *
     * `oldBases` are commits of the old base of the branch, for a stacked branch whose parent merged. Then the rebase
     * runs "git rebase --onto <target> <old base>" and moves only the commits of the branch itself. This works after a
     * regular merge and after a squash merge. Without a usable commit, it is a usual rebase.
     */
    async rebase(worktree: string, onto?: string, oldBases: readonly string[] = []): Promise<RebaseResult> {
        if (onto !== undefined && !/^[\w][\w./-]*$/.test(onto)) throw new Error(`"${onto}" is not a branch name.`);
        const bad = oldBases.find(commit => !COMMIT_PATTERN.test(commit));
        if (bad !== undefined) throw new Error(`"${bad}" is not a commit hash.`);
        const before = await this.status(worktree);
        if (before.rebase) throw new Error('A rebase is already in progress. Continue or abort it in the Changes tab.');
        if (!before.branch) throw new Error('The worktree has no branch (a detached HEAD).');
        if (hasUncommittedChanges(before)) throw new Error('The worktree has uncommitted changes. Commit or stash them first.');
        await run(worktree, ['fetch', '--quiet', '--prune', 'origin'], { timeout: 60_000 });
        this.fetches.set(await this.commonDir(worktree), { at: Date.now() });
        const target = onto ? `origin/${onto}` : await this.defaultRemoteBranch(worktree);
        if (!target || (await run(worktree, ['rev-parse', '--verify', '-q', `${target}^{commit}`], { allowFailure: true })) === undefined) {
            throw new Error(onto ? `The branch "origin/${onto}" does not exist.` : 'ShipWarden cannot find the default branch of "origin".');
        }
        if (target === `origin/${before.branch}`) throw new Error(`The branch is ${target} itself. Use Pull to get its new commits.`);
        const changes = await this.status(worktree);
        if (changes.upstream && changes.behind > 0 && changes.ahead === 0) {
            throw new Error(`The branch does not have the newest commits of ${changes.upstream}. Pull first.`);
        }
        const key = `${worktree}\0${before.branch}`;
        const upstreamSha = changes.upstream
            ? (await run(worktree, ['rev-parse', '--verify', '-q', `${changes.upstream}^{commit}`], { allowFailure: true }))?.trim()
            : undefined;
        // A second rebase before the push keeps the first lease. A new lease could hide the commits of someone else.
        const remember = () => upstreamSha && !this.leases.has(key) && this.leases.set(key, upstreamSha);
        const head = await this.head(worktree);
        const from = await this.forkPoint(worktree, oldBases);
        try {
            await run(worktree, ['rebase', '--no-autostash', ...(from ? ['--onto', target, from] : [target])], { timeout: 180_000 });
        } catch (error) {
            const state = await this.rebaseState(worktree);
            if (!state) throw error;
            remember();
            return { status: 'conflict', state };
        }
        const changed = (await this.head(worktree)) !== head;
        if (changed) remember();
        return { status: 'done', onto: target, changed };
    }

    /**
     * Returns the newest commit of HEAD that is also in one of the candidates, or undefined. A candidate that git does
     * not know is ignored. The newest commit is the one that the others are ancestors of.
     */
    private async forkPoint(worktree: string, candidates: readonly string[]): Promise<string | undefined> {
        let best: string | undefined;
        for (const candidate of candidates) {
            const base = (await run(worktree, ['merge-base', 'HEAD', candidate], { allowFailure: true }))?.trim();
            if (!base) continue;
            if (!best || (await isAncestor(worktree, best, base))) best = base;
        }
        return best;
    }

    /** The commit of HEAD, or undefined before the first commit. */
    private async head(worktree: string): Promise<string | undefined> {
        return (await run(worktree, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true }))?.trim();
    }

    /**
     * Continues a rebase after the user resolved and staged the conflicts. When the next commit has a conflict, the
     * rebase stops again and the result has the new state.
     */
    async rebaseContinue(worktree: string): Promise<RebaseResult> {
        const changes = await this.status(worktree);
        if (!changes.rebase) throw new Error('No rebase is in progress.');
        if (changes.conflicted.length) {
            throw new Error(`Resolve and stage the files with conflicts first: ${changes.conflicted.map(change => change.path).join(', ')}.`);
        }
        return this.rebaseStep(worktree, changes.rebase, '--continue');
    }

    /** Skips the commit that stopped the rebase. The changes of that commit are lost. */
    async rebaseSkip(worktree: string): Promise<RebaseResult> {
        const changes = await this.status(worktree);
        if (!changes.rebase) throw new Error('No rebase is in progress.');
        return this.rebaseStep(worktree, changes.rebase, '--skip');
    }

    /** Runs "git rebase --continue" or "--skip", and returns the result. */
    private async rebaseStep(worktree: string, state: RebaseState, step: '--continue' | '--skip'): Promise<RebaseResult> {
        try {
            await run(worktree, ['rebase', step], { timeout: 180_000 });
        } catch (error) {
            const next = await this.status(worktree);
            // A new conflict stops the rebase again. Other errors, for example "No changes", go to the user.
            if (next.rebase && next.conflicted.length) return { status: 'conflict', state: next.rebase };
            if (error instanceof Error && /No changes|nothing to commit/i.test(error.message)) {
                throw new Error('The commit has no changes after the resolution. Skip it, or change the files.');
            }
            throw error;
        }
        const after = await this.rebaseState(worktree);
        if (after) return { status: 'conflict', state: after };
        return { status: 'done', onto: state.ontoName ?? state.onto.slice(0, 7), changed: true };
    }

    /** Stops the rebase with "git rebase --abort". The branch gets its commits from before the rebase again. */
    async rebaseAbort(worktree: string): Promise<void> {
        const changes = await this.status(worktree);
        if (!changes.rebase) throw new Error('No rebase is in progress.');
        await run(worktree, ['rebase', '--abort'], { timeout: 60_000 });
        if (changes.rebase.branch) this.leases.delete(`${worktree}\0${changes.rebase.branch}`);
    }

    /**
     * Returns the git data of a rebase conflict for an agent: the files with conflicts, the commit that stopped, and the
     * commits of each side that change the files.
     */
    async rebaseConflictInput(worktree: string): Promise<RebaseConflictInput> {
        const changes = await this.status(worktree);
        const state = changes.rebase;
        if (!state) throw new Error('No rebase is in progress.');
        const files = changes.conflicted.map(change => change.path);
        const folder = await this.rebaseFolder(worktree);
        const original = folder ? await readRebaseFile(folder, 'orig-head') : undefined;
        const base = original ? (await run(worktree, ['merge-base', original, state.onto], { allowFailure: true }))?.trim() : undefined;
        const commits = async (from: string | undefined, to: string | undefined): Promise<string[]> => {
            if (!from || !to) return [];
            const output = await run(worktree, ['log', `--max-count=${MAX_CONFLICT_COMMITS}`, '--format=%h %s', `${from}..${to}`, '--', ...checkPaths(files)], {
                allowFailure: true
            });
            return (output ?? '').split('\n').filter(Boolean);
        };
        const [branchCommits, baseCommits] = await Promise.all([commits(base, original), commits(base, state.onto)]);
        return {
            ...(state.branch ? { branch: state.branch } : {}),
            onto: state.ontoName ?? state.onto.slice(0, 7),
            files,
            ...(state.stopped ? { stopped: state.stopped } : {}),
            branchCommits,
            baseCommits
        };
    }

    /**
     * Pushes the branch with "--force-with-lease" after a rebase, so the remote branch gets the new commits. After a
     * rebase in ShipWarden, the push replaces the remote branch only when it is still at the commit of the start of the
     * rebase. Else the lease is the remote branch of the last fetch.
     */
    async pushWithLease(worktree: string): Promise<void> {
        const changes = await this.status(worktree);
        if (changes.rebase) throw new Error('A rebase is in progress. Continue or abort it first.');
        if (!changes.branch) throw new Error('The worktree has no branch (a detached HEAD).');
        if (!changes.upstream) throw new Error('The branch has no upstream branch. Use Push.');
        const slash = changes.upstream.indexOf('/');
        const remote = changes.upstream.slice(0, slash);
        const remoteBranch = changes.upstream.slice(slash + 1);
        const key = `${worktree}\0${changes.branch}`;
        const lease = this.leases.get(key);
        try {
            await run(
                worktree,
                ['push', `--force-with-lease=refs/heads/${remoteBranch}${lease ? `:${lease}` : ''}`, remote, `HEAD:refs/heads/${remoteBranch}`],
                {
                    timeout: 180_000
                }
            );
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            if (/stale info|rejected/i.test(text)) {
                // The next try uses the remote branch of the last fetch.
                this.leases.delete(key);
                throw new Error(`${changes.upstream} changed after the rebase started. Fetch, look at the new commits, and try again.`);
            }
            throw error;
        }
        this.leases.delete(key);
    }

    /**
     * Pushes the branch. A branch without an upstream gets "origin" as its upstream. When the remote has no copy of
     * the upstream branch, the push makes that branch again.
     */
    async push(worktree: string): Promise<void> {
        const changes = await this.status(worktree);
        if (!changes.branch) throw new Error('The worktree has no branch (a detached HEAD). Make a branch first.');
        const args = !changes.upstream ? ['push', '-u', 'origin', changes.branch] : changes.upstreamGone ? goneUpstreamPush(changes.upstream) : ['push'];
        await run(worktree, args, { timeout: 180_000 });
    }
}

/** The arguments of a push that makes the upstream branch again on its remote, for example "origin/feature/x". */
export function goneUpstreamPush(upstream: string): string[] {
    const slash = upstream.indexOf('/');
    return ['push', '-u', upstream.slice(0, slash), `HEAD:refs/heads/${upstream.slice(slash + 1)}`];
}
