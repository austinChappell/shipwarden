import { promises as fs } from 'fs';
import * as path from 'path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { sessionIdOf } from '@shared/pinned-sessions';
import { recentSessionOf, type TranscriptSummary } from '@shared/recent-sessions';
import {
    ftsQueryOf,
    indexTranscriptLines,
    inFolders,
    MAX_SEARCH_HITS,
    SNIPPET_END,
    SNIPPET_START,
    type SearchEntryKind,
    type TranscriptIndexProgress,
    type TranscriptSearchHit,
    type TranscriptSearchQuery,
    type TranscriptSearchResult
} from '@shared/transcript-search';
import { claudeDataRoots } from '../automations/token-counter';
import { readTranscript, transcriptPath } from './transcript-reader';

/** The version of the tables. A different version in the file removes the index, and the index reads all transcripts again. */
const SCHEMA_VERSION = 1;

/** One read reads at most this number of bytes. The index then lets other work run before the next read. */
const CHUNK_BYTES = 512 * 1024;

/** A search reads at most this number of matching parts before it groups them by session. */
const MAX_MATCH_ROWS = 2000;

/** The time between two full scans of the Claude Code data folders. */
const SCAN_INTERVAL_MS = 10 * 60 * 1000;

/** The time after the start of the app before the first scan. The start of the app has more important work. */
const FIRST_SCAN_DELAY_MS = 15 * 1000;

export interface TranscriptIndexOptions {
    /** The SQLite file of the index. */
    file: string;
    roots?: () => readonly string[];
}

interface FileRow {
    id: number;
    path: string;
    session_id: string;
    offset: number;
    size: number;
    mtime: number;
    summary: string;
}

interface MatchRow {
    path: string;
    session_id: string;
    summary: string;
    model: string | null;
    updated_at: number;
    kind: SearchEntryKind;
    at: number;
    snippet: string;
}

interface Statements {
    fileByPath: StatementSync;
    insertFile: StatementSync;
    updateFile: StatementSync;
    insertEntry: StatementSync;
    deleteEntries: StatementSync;
    deleteFile: StatementSync;
}

/** Lets the event loop run other work, for example IPC calls, before the next step. */
function nextTurn(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

function parseSummary(value: string | undefined): TranscriptSummary {
    try {
        const summary = JSON.parse(value ?? '{}');
        return summary && typeof summary === 'object' ? summary : {};
    } catch {
        return {};
    }
}

/**
 * The search index of the Claude Code transcripts. It is an SQLite FTS5 table in the app data folder (`node:sqlite`).
 * - The index holds the user prompts, the agent text, and the file paths of the tool calls. It does not hold tool output.
 * - It reads only the new lines of a changed transcript. It keeps the byte offset of each transcript.
 * - It reads one transcript at a time, in small parts, so that the main process stays free for other work.
 */
export class TranscriptIndex {
    private readonly file: string;
    private readonly roots: () => readonly string[];
    private db: DatabaseSync | undefined;
    private statements: Statements | undefined;
    private opening: Promise<void> | undefined;
    /** The error when SQLite cannot open. Then the search is not available. */
    private failure: string | undefined;
    private readonly pending = new Set<string>();
    private draining: Promise<void> | undefined;
    private progress: TranscriptIndexProgress | undefined;
    private scanning: Promise<void> | undefined;
    private timers: NodeJS.Timeout[] = [];
    private closed = false;

    constructor(options: TranscriptIndexOptions) {
        this.file = options.file;
        this.roots = options.roots ?? claudeDataRoots;
    }

    /** Starts the scans: the first scan after a short delay, then a scan at a fixed interval. */
    start(): void {
        const scan = () => void this.scan().catch(error => console.warn(`[transcript-index] The scan failed: ${String(error)}`));
        const first = setTimeout(scan, FIRST_SCAN_DELAY_MS);
        const repeat = setInterval(scan, SCAN_INTERVAL_MS);
        first.unref?.();
        repeat.unref?.();
        this.timers.push(first, repeat);
    }

    /**
     * Finds all transcripts in the Claude Code data folders and reads the new lines of each changed transcript, the
     * newest transcript first. Removes the transcripts that are gone. A scan that runs gives its promise to a second call.
     */
    scan(): Promise<void> {
        this.scanning ??= this.runScan().finally(() => {
            this.scanning = undefined;
        });
        return this.scanning;
    }

    /** Reads the new lines of one transcript soon. A path that is not a Claude Code transcript does nothing. */
    update(file: string | undefined): void {
        if (!file || this.closed) return;
        let resolved: string;
        try {
            resolved = transcriptPath(file, this.roots());
        } catch {
            return;
        }
        if (!sessionIdOf(resolved)) return;
        this.enqueue([resolved]);
    }

    /** Resolves when the index has read all transcripts in its queue. */
    async idle(): Promise<void> {
        while (this.draining) await this.draining;
    }

    /** Finds the sessions that match the query. Throws an error when SQLite is not available. */
    async search(query: TranscriptSearchQuery): Promise<TranscriptSearchResult> {
        await this.open();
        const db = this.database();
        const models = (db.prepare('SELECT DISTINCT model FROM files WHERE model IS NOT NULL ORDER BY model').all() as { model: string }[]).map(
            row => row.model
        );
        const progress = this.progress && { ...this.progress };
        const match = ftsQueryOf(String(query?.text ?? ''));
        if (!match) return { hits: [], models, ...(progress ? { progress } : {}) };

        const where = ['entries MATCH ?'];
        const params: (string | number)[] = [match];
        if (typeof query.since === 'number' && Number.isFinite(query.since)) {
            where.push('e.at >= ?');
            params.push(query.since);
        }
        if (typeof query.model === 'string' && query.model) {
            where.push('f.model = ?');
            params.push(query.model);
        }
        params.push(MAX_MATCH_ROWS);
        const rows = db
            .prepare(
                `SELECT f.path, f.session_id, f.summary, f.model, f.updated_at, e.kind, e.at,
                    snippet(entries, 0, '${SNIPPET_START}', '${SNIPPET_END}', '…', 16) AS snippet
                 FROM entries e JOIN files f ON f.id = e.file_id
                 WHERE ${where.join(' AND ')}
                 ORDER BY bm25(entries) LIMIT ?`
            )
            .all(...params) as unknown as MatchRow[];

        const folders = Array.isArray(query.folders) ? query.folders.filter((folder): folder is string => typeof folder === 'string') : undefined;
        const bySession = new Map<string, TranscriptSearchHit>();
        for (const row of rows) {
            const existing = bySession.get(row.session_id);
            if (existing) {
                // A resume in another folder makes a copy of the transcript. The newest copy wins.
                if (existing.transcript === row.path) existing.matches++;
                continue;
            }
            const session = recentSessionOf(parseSummary(row.summary), { transcript: row.path, sessionId: row.session_id, updatedAt: row.updated_at });
            if (!session || !inFolders(session.cwd, folders)) continue;
            bySession.set(row.session_id, {
                ...session,
                ...(row.model ? { model: row.model } : {}),
                kind: row.kind,
                snippet: row.snippet,
                at: row.at,
                matches: 1
            });
        }
        const hits = [...bySession.values()].sort((a, b) => b.at - a.at).slice(0, MAX_SEARCH_HITS);
        return { hits, models, ...(progress ? { progress } : {}) };
    }

    /** Stops the scans and closes the file. */
    close(): void {
        this.closed = true;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers = [];
        this.pending.clear();
        try {
            this.db?.close();
        } catch {
            // The file is closed already.
        }
        this.db = undefined;
        this.statements = undefined;
    }

    private async runScan(): Promise<void> {
        if (this.closed) return;
        await this.open();
        if (!this.db) return;
        const db = this.db;
        const known = new Map((db.prepare('SELECT path, size, mtime FROM files').all() as unknown as FileRow[]).map(row => [row.path, row]));
        const found: { path: string; mtimeMs: number }[] = [];
        for (const root of this.roots()) {
            const projects = path.join(root, 'projects');
            const folders = await fs.readdir(projects, { withFileTypes: true }).catch(() => []);
            for (const folder of folders) {
                if (!folder.isDirectory()) continue;
                const dir = path.join(projects, folder.name);
                const names = await fs.readdir(dir).catch(() => [] as string[]);
                for (const name of names) {
                    const file = path.join(dir, name);
                    if (!sessionIdOf(file)) continue;
                    const stat = await fs.stat(file).catch(() => undefined);
                    if (!stat?.isFile()) continue;
                    const row = known.get(file);
                    known.delete(file);
                    if (row && row.size === stat.size && row.mtime === stat.mtimeMs) continue;
                    found.push({ path: file, mtimeMs: stat.mtimeMs });
                }
                await nextTurn();
            }
        }
        if (this.closed) return;
        // The transcripts that are gone leave the index.
        for (const file of known.keys()) this.removeFile(file);
        found.sort((a, b) => b.mtimeMs - a.mtimeMs);
        this.enqueue(found.map(item => item.path));
        await this.idle();
    }

    private enqueue(files: readonly string[]): void {
        let added = 0;
        for (const file of files) {
            if (this.pending.has(file)) continue;
            this.pending.add(file);
            added++;
        }
        if (added === 0) return;
        this.progress = { done: this.progress?.done ?? 0, total: (this.progress?.total ?? 0) + added };
        this.draining ??= this.drain().finally(() => {
            this.draining = undefined;
            this.progress = undefined;
        });
    }

    private async drain(): Promise<void> {
        await this.open();
        if (!this.db) {
            // SQLite is not available. The search shows the error, so the queue is not useful.
            this.pending.clear();
            return;
        }
        while (!this.closed) {
            const next = this.pending.values().next();
            if (next.done) break;
            const file = next.value;
            try {
                await this.indexFile(file);
            } catch (error) {
                console.warn(`[transcript-index] ${file} was not indexed: ${String(error)}`);
            }
            this.pending.delete(file);
            if (this.progress) this.progress.done++;
            await nextTurn();
        }
    }

    /** Reads the new lines of a transcript into the index. A transcript that got shorter is read again from the start. */
    private async indexFile(file: string): Promise<void> {
        const stat = await fs.stat(file).catch(() => undefined);
        if (this.closed) return;
        if (!stat?.isFile()) {
            this.removeFile(file);
            return;
        }
        const statements = this.prepared();
        let row = statements.fileByPath.get(file) as unknown as FileRow | undefined;
        if (row && row.size === stat.size && row.mtime === stat.mtimeMs) return;
        if (!row) {
            const sessionId = sessionIdOf(file);
            if (!sessionId) return;
            statements.insertFile.run(file, sessionId);
            row = statements.fileByPath.get(file) as unknown as FileRow;
        }
        let offset = row.offset;
        let summary = parseSummary(row.summary);
        if (stat.size < offset) {
            // Claude Code wrote the file again. The old parts leave the index.
            statements.deleteEntries.run(row.id);
            offset = 0;
            summary = {};
        }
        while (offset < stat.size && !this.closed) {
            const chunk = await readTranscript(file, offset, this.roots(), CHUNK_BYTES);
            if (this.closed) return;
            if (chunk.truncated) {
                // The file got shorter during the read. The next update reads it again from the start.
                statements.deleteEntries.run(row.id);
                statements.updateFile.run(0, 0, 0, '{}', null, 0, row.id);
                return;
            }
            // Only an incomplete line is left. The next change of the file brings the rest.
            if (chunk.offset <= offset) break;
            const indexed = indexTranscriptLines(summary, chunk.lines);
            summary = indexed.summary;
            offset = chunk.offset;
            // A size of -1 tells the next scan that the file is not complete in the index. The last step below sets the size.
            this.write(row.id, indexed.entries, stat.mtimeMs, () =>
                statements.updateFile.run(offset, -1, -1, JSON.stringify(summary), indexed.model ?? null, stat.mtimeMs, row.id)
            );
            await nextTurn();
        }
        if (this.closed) return;
        // The file can end with an incomplete line. It is complete in the index up to that line.
        statements.updateFile.run(offset, stat.size, stat.mtimeMs, JSON.stringify(summary), null, stat.mtimeMs, row.id);
    }

    /** Writes the parts of a transcript and the new state of its file in one transaction. */
    private write(fileId: number, entries: ReturnType<typeof indexTranscriptLines>['entries'], fallbackAt: number, updateFile: () => void): void {
        const db = this.database();
        const statements = this.prepared();
        db.exec('BEGIN');
        try {
            for (const entry of entries) statements.insertEntry.run(entry.text, fileId, entry.kind, entry.at ?? Math.round(fallbackAt));
            updateFile();
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    private removeFile(file: string): void {
        const statements = this.prepared();
        const row = statements.fileByPath.get(file) as unknown as FileRow | undefined;
        if (!row) return;
        statements.deleteEntries.run(row.id);
        statements.deleteFile.run(row.id);
    }

    private database(): DatabaseSync {
        if (!this.db) throw new Error(this.failure ? `Transcript search is not available: ${this.failure}` : 'The transcript index is closed.');
        return this.db;
    }

    private prepared(): Statements {
        if (!this.statements) throw new Error('The transcript index is closed.');
        return this.statements;
    }

    /** Opens the SQLite file and makes the tables. A file that SQLite cannot read is removed and made again. */
    private open(): Promise<void> {
        this.opening ??= (async () => {
            try {
                const { DatabaseSync } = await import('node:sqlite');
                if (this.closed) return;
                await fs.mkdir(path.dirname(this.file), { recursive: true }).catch(() => undefined);
                try {
                    this.db = this.create(new DatabaseSync(this.file));
                } catch {
                    await fs.rm(this.file, { force: true });
                    this.db = this.create(new DatabaseSync(this.file));
                }
            } catch (error) {
                this.failure = error instanceof Error ? error.message : String(error);
                console.warn(`[transcript-index] SQLite is not available: ${this.failure}`);
            }
        })();
        return this.opening;
    }

    private create(db: DatabaseSync): DatabaseSync {
        try {
            const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
            if (version !== SCHEMA_VERSION) {
                db.exec('DROP TABLE IF EXISTS entries; DROP TABLE IF EXISTS files;');
            }
            db.exec(`
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS files (
                    id INTEGER PRIMARY KEY,
                    path TEXT NOT NULL UNIQUE,
                    session_id TEXT NOT NULL,
                    offset INTEGER NOT NULL DEFAULT 0,
                    size INTEGER NOT NULL DEFAULT -1,
                    mtime REAL NOT NULL DEFAULT -1,
                    summary TEXT NOT NULL DEFAULT '{}',
                    model TEXT,
                    updated_at INTEGER NOT NULL DEFAULT 0
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS entries USING fts5(text, file_id UNINDEXED, kind UNINDEXED, at UNINDEXED);
                PRAGMA user_version = ${SCHEMA_VERSION};
            `);
            this.statements = {
                fileByPath: db.prepare('SELECT id, path, session_id, offset, size, mtime, summary FROM files WHERE path = ?'),
                insertFile: db.prepare('INSERT INTO files (path, session_id) VALUES (?, ?)'),
                updateFile: db.prepare(
                    'UPDATE files SET offset = ?, size = ?, mtime = ?, summary = ?, model = COALESCE(?, model), updated_at = ? WHERE id = ?'
                ),
                insertEntry: db.prepare('INSERT INTO entries (text, file_id, kind, at) VALUES (?, ?, ?, ?)'),
                deleteEntries: db.prepare('DELETE FROM entries WHERE file_id = ?'),
                deleteFile: db.prepare('DELETE FROM files WHERE id = ?')
            };
            return db;
        } catch (error) {
            db.close();
            throw error;
        }
    }
}
