import { cleanSessionName } from './pinned-sessions';

/**
 * A Claude Code session of the last days, from its transcript. The user can resume it without a pin. ShipWarden keeps
 * no data for it: the list comes from the transcripts that Claude Code keeps.
 */
export interface RecentSession {
    /** The ID of the Claude Code session: the name of its transcript file without ".jsonl". */
    sessionId: string;
    /** The path of the transcript. */
    transcript: string;
    /** The title from Claude Code, or the first prompt when the session has no title. */
    name: string;
    /** The folder in which the session ran. */
    cwd: string;
    /** The git branch of the folder at the last message, if Claude Code recorded it. */
    branch?: string;
    /** The time of the last change to the transcript. */
    updatedAt: number;
}

/** The number of days that the list of recent sessions goes back. */
export const RECENT_SESSION_DAYS = 3;

/** The most recent sessions in the list. */
export const MAX_RECENT_SESSIONS = 100;

/** The data that ShipWarden reads from the lines of a transcript. */
export interface TranscriptSummary {
    cwd?: string;
    branch?: string;
    /** The name from `/rename` or `--name`. */
    customTitle?: string;
    /** The name that Claude Code gave the session. */
    aiTitle?: string;
    /** The first prompt that the user typed. */
    firstPrompt?: string;
    /** How Claude Code started: "cli" for an interactive session. Print mode and the SDK give other values. */
    entrypoint?: string;
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Returns the text of a user prompt, or undefined for a tool result, a command, or a message from Claude Code. */
function promptText(entry: Record<string, unknown>): string | undefined {
    if (entry.isMeta === true || entry.isSidechain === true) return undefined;
    const message = entry.message as { content?: unknown } | undefined;
    const content = message?.content;
    const value =
        typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                    .filter((part): part is { type: string; text: string } => part?.type === 'text' && typeof part.text === 'string')
                    .map(part => part.text)
                    .join('\n')
              : undefined;
    const prompt = text(value);
    // Slash commands and their output start with a tag, for example "<command-name>".
    return prompt && !prompt.startsWith('<') ? prompt : undefined;
}

/**
 * Adds the data of transcript lines to a summary. Give the lines in file order. A later title or branch replaces an
 * earlier one. A line that is not JSON is skipped.
 */
export function summarizeTranscriptLines(summary: TranscriptSummary, lines: readonly string[]): TranscriptSummary {
    const next = { ...summary };
    for (const line of lines) {
        let entry: Record<string, unknown>;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (!entry || typeof entry !== 'object') continue;
        if (entry.type === 'custom-title') next.customTitle = text(entry.customTitle) ?? next.customTitle;
        else if (entry.type === 'ai-title') next.aiTitle = text(entry.aiTitle) ?? next.aiTitle;
        next.cwd = text(entry.cwd) ?? next.cwd;
        next.branch = text(entry.gitBranch) ?? next.branch;
        next.entrypoint ??= text(entry.entrypoint);
        if (entry.type === 'user' && !next.firstPrompt) next.firstPrompt = promptText(entry);
    }
    return next;
}

/**
 * Returns the recent session of a transcript summary, or undefined when the session cannot show in the list. Only an
 * interactive session with a prompt and a folder can show. Print mode runs and SDK runs do not show.
 */
export function recentSessionOf(summary: TranscriptSummary, file: { transcript: string; sessionId: string; updatedAt: number }): RecentSession | undefined {
    if (!summary.cwd || !summary.firstPrompt) return undefined;
    if (summary.entrypoint && summary.entrypoint !== 'cli') return undefined;
    const name = cleanSessionName(summary.customTitle ?? summary.aiTitle ?? summary.firstPrompt) || 'Untitled session';
    return {
        sessionId: file.sessionId,
        transcript: file.transcript,
        name,
        cwd: summary.cwd,
        ...(summary.branch && summary.branch !== 'HEAD' ? { branch: summary.branch } : {}),
        updatedAt: file.updatedAt
    };
}

/**
 * Returns the recent sessions that show in the list: no session with a pin, and no session that runs in ShipWarden now.
 * Those sessions show in their own lists.
 */
export function visibleRecentSessions(sessions: readonly RecentSession[], pinnedIds: ReadonlySet<string>, runningIds: ReadonlySet<string>): RecentSession[] {
    return sessions.filter(session => !pinnedIds.has(session.sessionId) && !runningIds.has(session.sessionId));
}
