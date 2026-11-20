import { promptText, type RecentSession, summarizeEntry, type TranscriptSummary } from './recent-sessions';

/**
 * The search across all Claude Code transcripts (Agents view). The main process keeps an SQLite FTS5 index of the
 * transcripts in the app data folder. The index holds the user prompts, the agent text, and the file paths of the tool
 * calls. It does not hold the tool output.
 *
 * The functions of this module use no Electron API and no Node API. The main process and the page both use them.
 */

/** The kind of a part of a transcript in the index. */
export type SearchEntryKind = 'prompt' | 'text' | 'file';

/** One part of a transcript in the index. */
export interface SearchEntry {
    kind: SearchEntryKind;
    text: string;
    /** The time of the transcript line, in milliseconds. Undefined when the line has no time. */
    at?: number;
}

/** The index keeps at most this number of characters of one prompt or one agent text. */
export const MAX_ENTRY_CHARS = 8000;

/** The tool input fields that hold a file path or a folder path. */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const;

/** The data of transcript lines for the index. */
export interface IndexedLines {
    /** The summary with the data of the lines added. */
    summary: TranscriptSummary;
    /** The model of the last agent message in the lines, if a line tells it. */
    model?: string;
    entries: SearchEntry[];
}

function clip(value: string): string {
    return value.length > MAX_ENTRY_CHARS ? value.slice(0, MAX_ENTRY_CHARS) : value;
}

function timeOf(entry: Record<string, unknown>): number | undefined {
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
    return Number.isFinite(at) ? at : undefined;
}

/** Returns the parts of an agent message: its text and the file paths of its tool calls. Tool output is not included. */
function assistantEntries(entry: Record<string, unknown>, at: number | undefined): SearchEntry[] {
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return [];
    const entries: SearchEntry[] = [];
    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            entries.push({ kind: 'text', text: clip(part.text.trim()), at });
        } else if (part.type === 'tool_use' && part.input && typeof part.input === 'object') {
            for (const field of PATH_FIELDS) {
                const value = (part.input as Record<string, unknown>)[field];
                if (typeof value === 'string' && value.trim()) entries.push({ kind: 'file', text: value.trim(), at });
            }
        }
    }
    return entries;
}

/**
 * Reads transcript lines for the index. Give the lines in file order. The result has the user prompts, the agent text,
 * and the file paths of the tool calls. Tool output, subagent lines, and lines that are not JSON are skipped.
 */
export function indexTranscriptLines(summary: TranscriptSummary, lines: readonly string[]): IndexedLines {
    const next = { ...summary };
    const entries: SearchEntry[] = [];
    let model: string | undefined;
    for (const line of lines) {
        let entry: Record<string, unknown>;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (!entry || typeof entry !== 'object') continue;
        summarizeEntry(next, entry);
        if (entry.isSidechain === true) continue;
        const at = timeOf(entry);
        if (entry.type === 'user') {
            const prompt = promptText(entry);
            if (prompt) entries.push({ kind: 'prompt', text: clip(prompt), at });
        } else if (entry.type === 'assistant') {
            const value = (entry.message as { model?: unknown } | undefined)?.model;
            // Claude Code writes "<synthetic>" for the messages that it makes itself.
            if (typeof value === 'string' && value && !value.startsWith('<')) model = value;
            entries.push(...assistantEntries(entry, at));
        }
    }
    return { summary: next, model, entries };
}

/**
 * Returns the FTS5 query of the typed text, or undefined when the text has no word. Each word must be in the part, and
 * the last word can be the start of a longer word. A word is a phrase in quotes, so "auth.ts" finds "auth" then "ts".
 */
export function ftsQueryOf(text: string): string | undefined {
    const words = text
        .split(/\s+/)
        .map(word => word.replace(/"/g, ''))
        .filter(word => /[\p{L}\p{N}]/u.test(word));
    if (words.length === 0) return undefined;
    return words.map((word, index) => `"${word}"${index === words.length - 1 ? '*' : ''}`).join(' ');
}

/** True when the folder is one of the folders or is in one of them. No folders means all folders. */
export function inFolders(cwd: string, folders: readonly string[] | undefined): boolean {
    if (!folders || folders.length === 0) return true;
    return folders.some(folder => cwd === folder || cwd.startsWith(folder.endsWith('/') ? folder : `${folder}/`));
}

/** The query of a search. */
export interface TranscriptSearchQuery {
    text: string;
    /** Only the sessions that ran in these folders or in a folder in them. Empty or undefined means all folders. */
    folders?: string[];
    /** Only the sessions of this model. */
    model?: string;
    /** Only the parts that the transcript got after this time, in milliseconds. */
    since?: number;
}

/** One session that matches a search. */
export interface TranscriptSearchHit extends RecentSession {
    /** The model of the session. */
    model?: string;
    /** The kind of the best part that matches. */
    kind: SearchEntryKind;
    /** The text around the match. SNIPPET_START and SNIPPET_END mark the words that match. */
    snippet: string;
    /** The time of the best part that matches, in milliseconds. */
    at: number;
    /** The number of parts of the session that match. */
    matches: number;
}

/** The progress of the index while it reads transcripts. */
export interface TranscriptIndexProgress {
    done: number;
    total: number;
}

export interface TranscriptSearchResult {
    /** The sessions that match, the newest match first. */
    hits: TranscriptSearchHit[];
    /** The models in the index, for the filter. */
    models: string[];
    /** Set while the index reads transcripts. The hits can then be incomplete. */
    progress?: TranscriptIndexProgress;
}

/** The most sessions in the result of a search. */
export const MAX_SEARCH_HITS = 50;

/** The characters that mark the start and the end of a match in a snippet. */
export const SNIPPET_START = '\u0002';
export const SNIPPET_END = '\u0003';

/** Splits a snippet into its plain parts and its marked parts. */
export function snippetParts(snippet: string): { text: string; mark: boolean }[] {
    const parts: { text: string; mark: boolean }[] = [];
    for (const piece of snippet.split(SNIPPET_START)) {
        const end = piece.indexOf(SNIPPET_END);
        if (end < 0) {
            if (piece) parts.push({ text: piece, mark: false });
            continue;
        }
        if (end > 0) parts.push({ text: piece.slice(0, end), mark: true });
        const rest = piece.slice(end + 1);
        if (rest) parts.push({ text: rest, mark: false });
    }
    return parts.map(part => ({ ...part, text: part.text.replace(/\s+/g, ' ') }));
}

/** The labels of the kinds of parts. */
export const ENTRY_KIND_LABELS: Record<SearchEntryKind, string> = {
    prompt: 'Prompt',
    text: 'Agent',
    file: 'File'
};
