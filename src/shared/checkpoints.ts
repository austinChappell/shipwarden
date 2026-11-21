/**
 * The checkpoints of the agent turns. A checkpoint is a git commit of all the files of a worktree at one moment. A hidden
 * ref keeps it: `refs/shipwarden/checkpoints/<session>/<turn>`. The commit message holds the data of the checkpoint as JSON.
 */

/** The folder of the checkpoint refs. */
export const CHECKPOINT_REF_ROOT = 'refs/shipwarden/checkpoints';

/** ShipWarden removes the checkpoints that are older than 7 days. */
export const CHECKPOINT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The first line of the message of each checkpoint commit. */
export const CHECKPOINT_SUBJECT = 'ShipWarden checkpoint';

/** The largest diff text that a rewind preview sends to the page. */
export const MAX_PREVIEW_PATCH = 200_000;

/**
 * Why ShipWarden saved the checkpoint:
 * - "prompt": the agent got a prompt. The checkpoint is the state before the turn.
 * - "idle": an agent without a turn hook stopped its output. The checkpoint is the state after the turn.
 * - "rewind": the state just before a rewind, so the user can go back to it.
 */
export type CheckpointKind = 'prompt' | 'idle' | 'rewind';

/** The data in the message of a checkpoint commit. */
export interface CheckpointMeta {
    /** The top folder of the worktree. */
    worktree: string;
    /** The ID of the terminal session of the agent. */
    session: string;
    /** The number of the checkpoint in its session, from 1. */
    turn: number;
    kind: CheckpointKind;
    /** The time of the checkpoint, in milliseconds. */
    at: number;
    /** A summary of the prompt. Only a "prompt" checkpoint has it. */
    prompt?: string;
    /** The name of the agent tab. */
    agent?: string;
}

/** The status of a file in a diff between two checkpoints. */
export type CheckpointFileStatus = 'added' | 'modified' | 'deleted';

export interface CheckpointFile {
    path: string;
    status: CheckpointFileStatus;
}

/** A saved checkpoint, as the page shows it. */
export interface Checkpoint extends CheckpointMeta {
    /** The full name of the ref. */
    ref: string;
    /** The checkpoint commit. */
    commit: string;
    /** The HEAD commit at the time of the checkpoint. Undefined for a repository without commits. */
    head?: string;
    /** The files that changed after the checkpoint: until the next checkpoint of the session, or until now. */
    files: CheckpointFile[];
}

/** One file that a rewind changes. */
export interface RewindFile {
    path: string;
    /**
     * - "restore": the file is in the checkpoint, but not in the worktree now. The rewind writes it again.
     * - "revert": the file changed. The rewind writes the version of the checkpoint.
     * - "remove": the file is new since the checkpoint. The rewind deletes it.
     */
    action: 'restore' | 'revert' | 'remove';
    /** The added and removed lines from the current file to the checkpoint. Undefined for a binary file. */
    additions?: number;
    deletions?: number;
    binary: boolean;
}

/** A commit on the branch after the checkpoint. */
export interface RewindCommit {
    sha: string;
    subject: string;
}

/** What a rewind does. The page shows it before the user agrees. */
export interface RewindPreview {
    ref: string;
    files: RewindFile[];
    /** The unified diff from the current files to the checkpoint. It is cut at `MAX_PREVIEW_PATCH` characters. */
    patch: string;
    /** True when the diff is longer than the text in `patch`. */
    truncated: boolean;
    /** The commits after the checkpoint commit, the newest first. Empty when HEAD did not move. */
    commits: RewindCommit[];
    /** True when HEAD moved, but not forward from the checkpoint (for example after a rebase or a branch change). */
    headDiverged: boolean;
    /** True when the agent terminal of the checkpoint runs, so ShipWarden can send it a note. */
    agentRunning: boolean;
}

export interface RewindOptions {
    /** True to move the branch back to the HEAD of the checkpoint. Only for a branch that moved forward from it. */
    reset: boolean;
    /** True to send a short note about the rewind to the agent terminal of the checkpoint. */
    tellAgent: boolean;
}

export interface RewindResult {
    /** The number of files that the rewind wrote. */
    restored: number;
    /** The number of files that the rewind deleted. */
    removed: number;
    /** True when the rewind moved the branch back. */
    reset: boolean;
    /** The checkpoint of the state before the rewind. Undefined when the last checkpoint has that state already. */
    backup?: string;
}

/** The turns of one agent session, the newest first. */
export interface CheckpointSession {
    session: string;
    agent?: string;
    checkpoints: Checkpoint[];
}

/** Makes a safe ref part from a session ID. Git refuses some characters in a ref name. */
export function sessionRefPart(session: string): string {
    return session.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'session';
}

/** The ref of a checkpoint. The turn has 6 digits, so the refs sort in turn order. */
export function checkpointRef(session: string, turn: number): string {
    return `${CHECKPOINT_REF_ROOT}/${sessionRefPart(session)}/${String(turn).padStart(6, '0')}`;
}

/** The message of a checkpoint commit. */
export function checkpointMessage(meta: CheckpointMeta): string {
    return `${CHECKPOINT_SUBJECT}\n\n${JSON.stringify(meta)}\n`;
}

/** Reads the data of a checkpoint commit message. Undefined when the message is not a valid checkpoint message. */
export function parseCheckpointMessage(message: string): CheckpointMeta | undefined {
    if (!message.startsWith(CHECKPOINT_SUBJECT)) return undefined;
    const start = message.indexOf('{');
    if (start < 0) return undefined;
    try {
        const value = JSON.parse(message.slice(start)) as Record<string, unknown>;
        const kind = value.kind === 'idle' || value.kind === 'rewind' ? value.kind : 'prompt';
        if (typeof value.worktree !== 'string' || typeof value.session !== 'string') return undefined;
        if (typeof value.turn !== 'number' || typeof value.at !== 'number') return undefined;
        return {
            worktree: value.worktree,
            session: value.session,
            turn: value.turn,
            kind,
            at: value.at,
            ...(typeof value.prompt === 'string' ? { prompt: value.prompt } : {}),
            ...(typeof value.agent === 'string' ? { agent: value.agent } : {})
        };
    } catch {
        return undefined;
    }
}

/** True when a checkpoint of this time is older than the maximum age. */
export function checkpointExpired(at: number, now: number, maxAge = CHECKPOINT_MAX_AGE_MS): boolean {
    return now - at > maxAge;
}

/** Reads the NUL-separated output of `git diff-tree -z --name-status`. */
export function parseNameStatus(output: string): CheckpointFile[] {
    const parts = output.split('\0');
    const files: CheckpointFile[] = [];
    for (let index = 0; index + 1 < parts.length; index += 2) {
        const code = parts[index].trim().charAt(0);
        const path = parts[index + 1];
        if (!code || !path) continue;
        files.push({ path, status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified' });
    }
    return files;
}

/** Reads the NUL-separated output of `git diff-tree -z --numstat`, by path. A binary file has no counts. */
export function parseNumstat(output: string): Map<string, { additions?: number; deletions?: number }> {
    const counts = new Map<string, { additions?: number; deletions?: number }>();
    for (const record of output.split('\0')) {
        const match = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(record);
        if (!match) continue;
        counts.set(match[3], match[1] === '-' ? {} : { additions: Number(match[1]), deletions: Number(match[2]) });
    }
    return counts;
}

/** Puts the checkpoints in groups by session. The newest session and the newest checkpoint come first. */
export function groupCheckpoints(checkpoints: Checkpoint[]): CheckpointSession[] {
    const groups = new Map<string, CheckpointSession>();
    for (const checkpoint of [...checkpoints].sort((a, b) => b.at - a.at || b.turn - a.turn)) {
        let group = groups.get(checkpoint.session);
        if (!group) {
            group = { session: checkpoint.session, checkpoints: [] };
            groups.set(checkpoint.session, group);
        }
        group.agent ??= checkpoint.agent;
        group.checkpoints.push(checkpoint);
    }
    return [...groups.values()];
}

/** The title of a checkpoint in the list: the prompt, or why ShipWarden saved it. */
export function checkpointTitle(checkpoint: Pick<Checkpoint, 'kind' | 'prompt'>): string {
    switch (checkpoint.kind) {
        case 'idle':
            return 'Agent stopped its output';
        case 'rewind':
            return 'Before a rewind';
        default:
            return checkpoint.prompt ?? 'Prompt';
    }
}

/** The short note that ShipWarden can send to the agent after a rewind. */
export function rewindNote(checkpoint: Pick<Checkpoint, 'kind' | 'prompt'>, reset: boolean): string {
    const point = checkpoint.kind === 'prompt' && checkpoint.prompt ? `before the prompt "${checkpoint.prompt}"` : 'to an earlier checkpoint';
    const commits = reset ? ' The branch also moved back, so the commits after that point are gone.' : '';
    return `Note from ShipWarden: the user rewound the files of this worktree ${point}.${commits} Your changes after that point are not in the files now. Read the files again before you continue.`;
}
