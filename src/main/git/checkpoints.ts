import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    CHECKPOINT_REF_ROOT,
    MAX_PREVIEW_PATCH,
    checkpointExpired,
    checkpointMessage,
    checkpointRef,
    parseCheckpointMessage,
    parseNameStatus,
    parseNumstat,
    sessionRefPart,
    type Checkpoint,
    type CheckpointKind,
    type CheckpointMeta,
    type RewindCommit,
    type RewindFile,
    type RewindOptions,
    type RewindPreview,
    type RewindResult
} from '@shared/checkpoints';

/** The time limit of one git command. A large worktree with many new files needs time for "git add". */
const GIT_TIMEOUT_MS = 60_000;

/** The list shows at most this number of checkpoints for each worktree. */
const MAX_LISTED = 100;

/** The author of the checkpoint commits. Thus a repository without user.name and user.email can make them too. */
const AUTHOR_ENV = {
    GIT_AUTHOR_NAME: 'ShipWarden',
    GIT_AUTHOR_EMAIL: 'checkpoints@shipwarden.invalid',
    GIT_COMMITTER_NAME: 'ShipWarden',
    GIT_COMMITTER_EMAIL: 'checkpoints@shipwarden.invalid'
};

interface GitOptions {
    env?: Record<string, string>;
    /** The text on the standard input of git. */
    input?: string;
}

/** Runs git and returns its standard output. Rejects with the error text of git when the exit code is not 0. */
function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd, env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        const timer = setTimeout(() => child.kill('SIGTERM'), GIT_TIMEOUT_MS);
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
        child.on('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', code => {
            clearTimeout(timer);
            if (code === 0) {
                resolve(Buffer.concat(out).toString('utf8'));
            } else {
                const detail = Buffer.concat(err).toString('utf8').trim() || `exit code ${code}`;
                reject(new Error(`The command "git ${args.join(' ')}" failed: ${detail}`));
            }
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(options.input ?? '');
    });
}

/** Runs git and returns undefined when git fails. */
async function tryGit(cwd: string, args: string[], options?: GitOptions): Promise<string | undefined> {
    try {
        return await git(cwd, args, options);
    } catch {
        return undefined;
    }
}

/** The top folder of the worktree of a folder. Undefined when the folder is not in a git worktree. */
export async function worktreeTop(cwd: string): Promise<string | undefined> {
    return (await tryGit(cwd, ['rev-parse', '--show-toplevel']))?.trim() || undefined;
}

/** The HEAD commit. Undefined for a repository without commits. */
async function headOf(top: string): Promise<string | undefined> {
    return (await tryGit(top, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']))?.trim() || undefined;
}

/**
 * Runs `fn` with a temporary index file. The real index of the worktree does not change.
 * Without a tree, the temporary index starts as a copy of the real index, so "git add" can reuse the file times in it.
 * With a tree, it starts empty and `fn` reads the tree into it.
 */
async function withTempIndex<T>(top: string, copyRealIndex: boolean, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-checkpoint-'));
    const indexFile = path.join(folder, 'index');
    const env = { GIT_INDEX_FILE: indexFile };
    try {
        if (copyRealIndex) {
            const realIndex = path.resolve(top, (await git(top, ['rev-parse', '--git-path', 'index'])).trim());
            try {
                const stat = await fs.stat(realIndex);
                await fs.copyFile(realIndex, indexFile);
                // Keep the time of the real index on the copy. Git compares the file times in the index with the time
                // of the index file. A file that changes in the same second as the index write has the same time.
                // Git reads the contents of such a file again only if the index file has its real time.
                // A copy with a new time makes git skip a change that keeps the same size.
                await fs.utimes(indexFile, stat.atime, stat.mtime);
            } catch {
                // A worktree without an index file starts from HEAD. A repository without commits starts empty.
                if (await headOf(top)) await git(top, ['read-tree', 'HEAD'], { env });
            }
        }
        return await fn(env);
    } finally {
        await fs.rm(folder, { recursive: true, force: true });
    }
}

/** The state of all the files of a worktree. */
interface Snapshot {
    /** The tree of the tracked files and the new files that .gitignore does not ignore. */
    tree: string;
    head?: string;
}

/** Writes the tree of the current files of the worktree. The index, the files, and the stash list do not change. */
export async function snapshot(top: string): Promise<Snapshot> {
    const head = await headOf(top);
    const tree = await withTempIndex(top, true, async env => {
        await git(top, ['add', '-A', '--', '.'], { env });
        return (await git(top, ['write-tree'], { env })).trim();
    });
    return { tree, ...(head ? { head } : {}) };
}

/** A checkpoint ref with its commit data. */
interface StoredCheckpoint {
    ref: string;
    commit: string;
    tree: string;
    head?: string;
    meta?: CheckpointMeta;
}

/** Reads the checkpoint refs under a prefix, in ref order. */
async function readRefs(cwd: string, prefix = `${CHECKPOINT_REF_ROOT}/`): Promise<StoredCheckpoint[]> {
    const output = await tryGit(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(tree)%00%(parent)%00%(contents)%1e', prefix]);
    if (!output) return [];
    return output
        .split('\x1e')
        .map(record => record.replace(/^\n/, ''))
        .filter(Boolean)
        .map(record => {
            const [ref, commit, tree, parent, ...message] = record.split('\0');
            const meta = parseCheckpointMessage(message.join('\0'));
            return { ref, commit, tree, ...(parent ? { head: parent.split(' ')[0] } : {}), ...(meta ? { meta } : {}) };
        })
        .sort((a, b) => a.ref.localeCompare(b.ref));
}

/** The turn number at the end of a checkpoint ref. */
function turnOf(ref: string): number {
    return Number(ref.slice(ref.lastIndexOf('/') + 1)) || 0;
}

export interface CheckpointInput {
    session: string;
    kind: CheckpointKind;
    prompt?: string;
    agent?: string;
    now?: number;
}

/**
 * Saves a snapshot as a checkpoint of a session. Returns undefined when the last checkpoint of the session has the
 * same files and the same HEAD, so ShipWarden skips it.
 */
async function saveCheckpoint(top: string, state: Snapshot, input: CheckpointInput): Promise<{ ref: string; commit: string } | undefined> {
    const refs = await readRefs(top, `${CHECKPOINT_REF_ROOT}/${sessionRefPart(input.session)}/`);
    const last = refs.at(-1);
    if (last && last.tree === state.tree && last.head === state.head) return undefined;
    const turn = last ? turnOf(last.ref) + 1 : 1;
    const meta: CheckpointMeta = {
        worktree: top,
        session: input.session,
        turn,
        kind: input.kind,
        at: input.now ?? Date.now(),
        ...(input.prompt ? { prompt: input.prompt } : {}),
        ...(input.agent ? { agent: input.agent } : {})
    };
    const parents = state.head ? ['-p', state.head] : [];
    const commit = (
        await git(top, ['commit-tree', '--no-gpg-sign', state.tree, ...parents, '-F', '-'], { env: AUTHOR_ENV, input: checkpointMessage(meta) })
    ).trim();
    const ref = checkpointRef(input.session, turn);
    await git(top, ['update-ref', ref, commit]);
    return { ref, commit };
}

/**
 * Saves the current files of the worktree of `cwd` as a checkpoint. It includes the tracked files with their
 * uncommitted changes and the new files that .gitignore does not ignore. The index, the files, and the stash list do
 * not change. Returns undefined when `cwd` is not in a git worktree or when nothing changed since the last checkpoint.
 */
export async function createCheckpoint(cwd: string, input: CheckpointInput): Promise<{ ref: string; commit: string } | undefined> {
    const top = await worktreeTop(cwd);
    if (!top) return undefined;
    return saveCheckpoint(top, await snapshot(top), input);
}

/** The changed files between two trees. */
async function changedFiles(top: string, from: string, to: string) {
    if (from === to) return [];
    return parseNameStatus(await git(top, ['diff-tree', '-r', '-z', '--name-status', '--no-renames', from, to]));
}

/** Compares two paths of the same folder. On macOS, /tmp is a link to /private/tmp. */
async function samePath(a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    const real = (value: string) => fs.realpath(value).catch(() => path.resolve(value));
    return (await real(a)) === (await real(b));
}

/** The checkpoints of a worktree, the oldest first. */
async function worktreeCheckpoints(top: string): Promise<(StoredCheckpoint & { meta: CheckpointMeta })[]> {
    const refs = await readRefs(top);
    return refs.filter((item): item is StoredCheckpoint & { meta: CheckpointMeta } => item.meta?.worktree === top);
}

/**
 * Lists the checkpoints of the worktree of `cwd`, the newest first. Each checkpoint has the files that changed after it:
 * until the next checkpoint of its session, or until now for the last one.
 */
export async function listCheckpoints(cwd: string): Promise<Checkpoint[]> {
    const top = await worktreeTop(cwd);
    if (!top) return [];
    const stored = (await worktreeCheckpoints(top)).sort((a, b) => a.meta.at - b.meta.at).slice(-MAX_LISTED);
    if (stored.length === 0) return [];
    const current = (await snapshot(top)).tree;
    const result: Checkpoint[] = [];
    for (const [index, item] of stored.entries()) {
        const next = stored.slice(index + 1).find(other => other.meta.session === item.meta.session);
        result.push({
            ...item.meta,
            ref: item.ref,
            commit: item.commit,
            ...(item.head ? { head: item.head } : {}),
            files: await changedFiles(top, item.tree, next?.tree ?? current)
        });
    }
    return result.reverse();
}

/** Reads one checkpoint of the worktree. Throws when the ref is not a checkpoint of this worktree. */
async function readCheckpoint(top: string, ref: string): Promise<StoredCheckpoint & { meta: CheckpointMeta }> {
    if (!ref.startsWith(`${CHECKPOINT_REF_ROOT}/`)) throw new Error(`"${ref}" is not a checkpoint.`);
    const found = (await readRefs(top, ref)).find(item => item.ref === ref);
    if (!found?.meta) throw new Error('The checkpoint does not exist. ShipWarden removes checkpoints after 7 days.');
    if (found.meta.worktree !== top) throw new Error('The checkpoint is of a different worktree.');
    return found as StoredCheckpoint & { meta: CheckpointMeta };
}

/** True when `ancestor` is an ancestor of `commit`. */
async function isAncestor(top: string, ancestor: string, commit: string): Promise<boolean> {
    return (await tryGit(top, ['merge-base', '--is-ancestor', ancestor, commit])) !== undefined;
}

/** The position of HEAD relative to the HEAD of a checkpoint. */
async function headMove(top: string, checkpointHead: string | undefined, head: string | undefined) {
    if (checkpointHead === head) return { commits: [] as RewindCommit[], diverged: false };
    if (!checkpointHead || !head || !(await isAncestor(top, checkpointHead, head))) return { commits: [] as RewindCommit[], diverged: true };
    const log = await git(top, ['log', '--format=%H%x00%s', '-n', '50', `${checkpointHead}..${head}`]);
    const commits = log
        .split('\n')
        .filter(Boolean)
        .map(line => {
            const [sha, subject] = line.split('\0');
            return { sha, subject: subject ?? '' };
        });
    return { commits, diverged: false };
}

/** Shows what a rewind to a checkpoint changes. `agentRunning` comes from the terminal sessions. */
export async function previewRewind(cwd: string, ref: string, agentRunning = false): Promise<RewindPreview> {
    const top = await worktreeTop(cwd);
    if (!top) throw new Error('The folder is not a git worktree.');
    const checkpoint = await readCheckpoint(top, ref);
    const state = await snapshot(top);
    const diff = ['diff-tree', '-r', '-z', '--no-renames', state.tree, checkpoint.tree];
    const [names, numstat, patch, move] = await Promise.all([
        git(top, [...diff.slice(0, 3), '--name-status', ...diff.slice(3)]),
        git(top, [...diff.slice(0, 3), '--numstat', ...diff.slice(3)]),
        git(top, ['diff-tree', '-r', '-p', '--no-renames', '--no-color', '--no-ext-diff', state.tree, checkpoint.tree]),
        headMove(top, checkpoint.head, state.head)
    ]);
    const counts = parseNumstat(numstat);
    const files: RewindFile[] = parseNameStatus(names).map(file => {
        const count = counts.get(file.path);
        const binary = !count || count.additions === undefined;
        return {
            path: file.path,
            action: file.status === 'added' ? 'restore' : file.status === 'deleted' ? 'remove' : 'revert',
            ...(binary ? {} : { additions: count.additions, deletions: count.deletions }),
            binary
        };
    });
    return {
        ref,
        files,
        patch: patch.slice(0, MAX_PREVIEW_PATCH),
        truncated: patch.length > MAX_PREVIEW_PATCH,
        commits: move.commits,
        headDiverged: move.diverged,
        agentRunning
    };
}

/** Removes the empty folders above a deleted file, up to the top folder of the worktree. */
async function removeEmptyParents(top: string, file: string): Promise<void> {
    let folder = path.dirname(file);
    while (folder !== top && folder.startsWith(`${top}${path.sep}`)) {
        try {
            await fs.rmdir(folder);
        } catch {
            return;
        }
        folder = path.dirname(folder);
    }
}

/**
 * Restores the files of the worktree to a checkpoint:
 * - It first saves the current files as a "rewind" checkpoint, so the user can go back.
 * - It writes the files that changed or that the agent deleted, also binary files.
 * - It deletes the files that are new since the checkpoint. Files that .gitignore ignores stay.
 * - With `reset`, it moves the branch and the index back to the HEAD of the checkpoint. The files stay as the checkpoint.
 * Without `reset`, the commits after the checkpoint stay on the branch, and the index does not change.
 */
export async function rewindToCheckpoint(
    cwd: string,
    ref: string,
    options: Pick<RewindOptions, 'reset'>,
    now = Date.now()
): Promise<RewindResult & { checkpoint: CheckpointMeta }> {
    const top = await worktreeTop(cwd);
    if (!top) throw new Error('The folder is not a git worktree.');
    const checkpoint = await readCheckpoint(top, ref);
    const state = await snapshot(top);
    const move = options.reset ? await headMove(top, checkpoint.head, state.head) : undefined;
    if (move && (move.diverged || move.commits.length === 0)) {
        throw new Error('ShipWarden cannot move the branch back, because it did not move forward from the checkpoint.');
    }
    const backup = await saveCheckpoint(top, state, { session: checkpoint.meta.session, kind: 'rewind', agent: checkpoint.meta.agent, now });
    const changes = await changedFiles(top, state.tree, checkpoint.tree);
    const removes = changes.filter(file => file.status === 'deleted').map(file => file.path);
    const writes = changes.filter(file => file.status !== 'deleted').map(file => file.path);

    for (const file of removes) {
        const target = path.join(top, file);
        await fs.rm(target, { force: true });
        await removeEmptyParents(top, target);
    }
    if (writes.length > 0) {
        await withTempIndex(top, false, async env => {
            await git(top, ['read-tree', checkpoint.tree], { env });
            await git(top, ['checkout-index', '-f', '-z', '--stdin'], { env, input: `${writes.join('\0')}\0` });
        });
    }
    if (move && checkpoint.head) {
        await git(top, ['reset', '-q', '--mixed', checkpoint.head]);
    }
    return { restored: writes.length, removed: removes.length, reset: !!move, ...(backup ? { backup: backup.ref } : {}), checkpoint: checkpoint.meta };
}

/** Deletes refs with one git command. */
async function deleteRefs(cwd: string, refs: string[]): Promise<number> {
    if (refs.length === 0) return 0;
    await git(cwd, ['update-ref', '--stdin'], { input: refs.map(ref => `delete ${ref}\n`).join('') });
    return refs.length;
}

/** Deletes the checkpoints of a worktree. Call it after the worktree goes away. Returns the number of deleted refs. */
export async function removeWorktreeCheckpoints(repo: string, worktree: string): Promise<number> {
    const refs = await readRefs(repo);
    const doomed: string[] = [];
    for (const item of refs) {
        if (item.meta && (await samePath(item.meta.worktree, worktree))) doomed.push(item.ref);
    }
    return deleteRefs(repo, doomed);
}

/**
 * Deletes the checkpoints of a repository that are older than 7 days, the checkpoints of a worktree folder that does not
 * exist anymore, and the refs without valid checkpoint data. Returns the number of deleted refs.
 */
export async function pruneCheckpoints(repo: string, now = Date.now()): Promise<number> {
    const refs = await readRefs(repo);
    const folders = new Map<string, Promise<boolean>>();
    const exists = (folder: string) => {
        let value = folders.get(folder);
        if (!value) {
            value = fs.access(folder).then(
                () => true,
                () => false
            );
            folders.set(folder, value);
        }
        return value;
    };
    const doomed: string[] = [];
    for (const item of refs) {
        if (!item.meta || checkpointExpired(item.meta.at, now) || !(await exists(item.meta.worktree))) doomed.push(item.ref);
    }
    return deleteRefs(repo, doomed);
}
