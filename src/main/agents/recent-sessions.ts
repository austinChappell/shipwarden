import { promises as fs } from 'fs';
import * as path from 'path';
import { sessionIdOf } from '@shared/pinned-sessions';
import {
    MAX_RECENT_SESSIONS,
    RECENT_SESSION_DAYS,
    recentSessionOf,
    summarizeTranscriptLines,
    type RecentSession,
    type TranscriptSummary
} from '@shared/recent-sessions';
import { claudeDataRoots } from '../automations/token-counter';
import { copyTranscriptFor } from './session-resume';
import { transcriptPath } from './transcript-reader';

/** ShipWarden reads this many bytes from the start of a transcript: the folder, the branch, and the first prompt. */
const HEAD_BYTES = 128 * 1024;
/** ShipWarden reads this many bytes from the end of a transcript: the newest title and branch. */
const TAIL_BYTES = 256 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
    mtimeMs: number;
    size: number;
    session: RecentSession | undefined;
}

export interface RecentSessionsOptions {
    roots?: () => readonly string[];
    now?: () => number;
}

/**
 * Lists the Claude Code sessions of the last RECENT_SESSION_DAYS days from the transcripts in
 * `<Claude data>/projects/<folder>/<session ID>.jsonl`. ShipWarden reads only the start and the end of each transcript,
 * and it keeps the result until the file changes.
 */
export class RecentSessions {
    private readonly roots: () => readonly string[];
    private readonly now: () => number;
    private readonly cache = new Map<string, CacheEntry>();

    constructor(options: RecentSessionsOptions = {}) {
        this.roots = options.roots ?? claudeDataRoots;
        this.now = options.now ?? Date.now;
    }

    /** The recent interactive sessions, the newest first. */
    async list(): Promise<RecentSession[]> {
        const since = this.now() - RECENT_SESSION_DAYS * DAY_MS;
        const files = (await Promise.all(this.roots().map(root => recentFiles(path.join(root, 'projects'), since)))).flat();
        files.sort((a, b) => b.mtimeMs - a.mtimeMs);
        const seen = new Set<string>();
        const sessions: RecentSession[] = [];
        const kept = new Set<string>();
        for (const file of files) {
            if (sessions.length >= MAX_RECENT_SESSIONS) break;
            kept.add(file.path);
            const session = await this.read(file);
            // A resume in another folder makes a copy. The newest copy wins.
            if (!session || seen.has(session.sessionId)) continue;
            seen.add(session.sessionId);
            sessions.push(session);
        }
        for (const key of this.cache.keys()) if (!kept.has(key)) this.cache.delete(key);
        return sessions;
    }

    /**
     * Makes a recent session available to Claude Code in the target folder. Returns the transcript path there. Throws an
     * error when the transcript is not a Claude Code transcript.
     */
    async prepareResume(transcript: string, cwd: string): Promise<string> {
        const source = transcriptPath(String(transcript ?? ''), this.roots());
        const sessionId = sessionIdOf(source);
        if (!sessionId) throw new Error('The transcript name is not a Claude Code session ID.');
        const folder = String(cwd ?? '').trim();
        if (!path.isAbsolute(folder)) throw new Error('The folder of the resume is not an absolute path.');
        return copyTranscriptFor(source, sessionId, folder);
    }

    private async read(file: TranscriptFile): Promise<RecentSession | undefined> {
        const cached = this.cache.get(file.path);
        if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) return cached.session;
        let session: RecentSession | undefined;
        try {
            const summary = await summarizeFile(file.path, file.size);
            session = recentSessionOf(summary, { transcript: file.path, sessionId: file.sessionId, updatedAt: file.mtimeMs });
        } catch {
            session = undefined;
        }
        this.cache.set(file.path, { mtimeMs: file.mtimeMs, size: file.size, session });
        return session;
    }
}

interface TranscriptFile {
    path: string;
    sessionId: string;
    mtimeMs: number;
    size: number;
}

/** Returns the transcripts in the folders of `projects` that changed after `since`. Subagent transcripts are not included. */
async function recentFiles(projects: string, since: number): Promise<TranscriptFile[]> {
    const folders = await fs.readdir(projects, { withFileTypes: true }).catch(() => []);
    const lists = await Promise.all(
        folders
            .filter(folder => folder.isDirectory())
            .map(async folder => {
                const dir = path.join(projects, folder.name);
                const names = await fs.readdir(dir).catch(() => [] as string[]);
                const files = await Promise.all(
                    names.map(async name => {
                        const file = path.join(dir, name);
                        const sessionId = sessionIdOf(file);
                        if (!sessionId) return undefined;
                        const stat = await fs.stat(file).catch(() => undefined);
                        if (!stat?.isFile() || stat.mtimeMs < since) return undefined;
                        return { path: file, sessionId, mtimeMs: stat.mtimeMs, size: stat.size };
                    })
                );
                return files.filter((file): file is TranscriptFile => !!file);
            })
    );
    return lists.flat();
}

/** Reads the start and the end of a transcript and returns its summary. */
async function summarizeFile(file: string, size: number): Promise<TranscriptSummary> {
    const handle = await fs.open(file, 'r');
    try {
        const headSize = Math.min(size, HEAD_BYTES);
        const head = Buffer.alloc(headSize);
        await handle.read(head, 0, headSize, 0);
        // The last line of the head can be incomplete. A file that fits in the head has only complete lines.
        let summary = summarizeTranscriptLines({}, lines(head, false, headSize < size));
        if (size > headSize) {
            const tailStart = Math.max(headSize, size - TAIL_BYTES);
            const tail = Buffer.alloc(size - tailStart);
            await handle.read(tail, 0, tail.length, tailStart);
            summary = summarizeTranscriptLines(summary, lines(tail, tailStart > headSize, false));
        }
        return summary;
    } finally {
        await handle.close();
    }
}

/** Returns the lines of a buffer. It skips an incomplete first line or an incomplete last line. */
function lines(buffer: Buffer, skipFirst: boolean, skipLast: boolean): string[] {
    const from = skipFirst ? buffer.indexOf(0x0a) + 1 : 0;
    const to = skipLast ? buffer.lastIndexOf(0x0a) : buffer.length;
    if (from <= 0 && skipFirst) return [];
    if (to < from) return [];
    return buffer.subarray(from, to).toString('utf8').split('\n').filter(Boolean);
}
