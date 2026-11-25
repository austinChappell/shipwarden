import type { ChatItem } from './agent-chat';
import { oneLine, shellQuote } from './agents';
import { normalizeTags } from './notes';

/**
 * A Claude Code session that the user pinned to resume later. The pin keeps the transcript of the session. The user can
 * resume the session in any worktree of any project.
 */
export interface PinnedSession {
    /** The ID of the pin. */
    id: string;
    /** The ID of the Claude Code session: the name of its transcript file without ".jsonl". */
    sessionId: string;
    /** The path of the newest transcript of the session. */
    transcript: string;
    /** The name of the session. The agent gives a name after the pin, and the user can change it. */
    name: string;
    /** True while the agent makes a name for the session. */
    naming?: boolean;
    /** The folder in which the session ran last. */
    cwd: string;
    /** The repository of that folder, if ShipWarden knows it. */
    repoPath?: string;
    /** The branch of that folder, if ShipWarden knows it. */
    branch?: string;
    /** The ID of the agent in Settings › Agents that ran the session. A resume uses its command. */
    agentId?: string;
    pinnedAt: number;
    /** The time of the last resume. */
    resumedAt?: number;
    /**
     * The time of the unpin. An unpinned session stays in "Recently unpinned" for UNPINNED_KEEP_DAYS days. Then
     * ShipWarden removes it. A pin without this time stays until the user unpins it.
     */
    unpinnedAt?: number;
}

/** The tags of the sessions, by the session ID. A session with or without a pin can have tags. */
export type SessionTags = Record<string, string[]>;

/** The pins and the tags of the sessions, as the main process keeps them. */
export interface PinState {
    /** The pins and the recently unpinned sessions, the newest pin or resume first. */
    pins: PinnedSession[];
    tags: SessionTags;
}

/** The data of a new pin, from the page. */
export interface PinRequest {
    transcript: string;
    cwd: string;
    repoPath?: string;
    branch?: string;
    agentId?: string;
    /** A name to show until the agent gives a better name, for example the last prompt. */
    fallbackName?: string;
}

/** The folder and the command to resume a pinned session. */
export interface ResumePlan {
    /** The command of the agent with `--resume` and the session ID. */
    command: string;
    /** The name of the agent for the tab title. */
    agentName: string;
}

/** The most pins that ShipWarden keeps. A new pin removes the oldest pin after this number. */
export const MAX_PINNED_SESSIONS = 200;

/** The number of days that an unpinned session stays in "Recently unpinned". */
export const UNPINNED_KEEP_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The most sessions with tags that ShipWarden keeps. After this number, it removes the tags of old sessions without a pin. */
export const MAX_TAGGED_SESSIONS = 1000;

/** The longest name of a session. */
export const MAX_SESSION_NAME = 60;

const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Returns the session ID of a transcript path, or undefined when the file name is not a session ID. */
export function sessionIdOf(transcript: string): string | undefined {
    const name = transcript.split('/').pop() ?? '';
    if (!name.endsWith('.jsonl')) return undefined;
    const id = name.slice(0, -'.jsonl'.length);
    return SESSION_ID.test(id) ? id : undefined;
}

/** The longest folder name that Claude Code makes from a working folder. A longer name gets a cut and a hash. */
export const MAX_PROJECT_FOLDER = 200;

/**
 * Returns the name of the folder in which Claude Code keeps the sessions of a working folder (`<root>/projects/<name>`).
 * Claude Code changes each character that is not a letter or a digit to "-". For a name that is longer than
 * MAX_PROJECT_FOLDER, Claude Code adds a hash, and this function returns undefined.
 */
export function claudeProjectFolder(cwd: string): string | undefined {
    const name = cwd.replace(/[^A-Za-z0-9]/g, '-');
    return name.length <= MAX_PROJECT_FOLDER ? name : undefined;
}

/**
 * Returns the command that resumes a session with an agent command, for example `claude --resume <id> --name '<name>'`.
 * Claude Code shows the name in its prompt box and in the terminal title.
 */
export function resumeCommand(agentCommand: string, sessionId: string, name?: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error('The session ID is not valid.');
    const label = name?.trim();
    return `${agentCommand.trim()} --resume ${sessionId}${label ? ` --name ${shellQuote(label)}` : ''}`;
}

/** Returns a clean session name: one line, no quotes or Markdown marks, at most MAX_SESSION_NAME characters. */
export function cleanSessionName(value: string): string {
    const line =
        value
            .split('\n')
            .map(part => part.trim())
            .find(Boolean) ?? '';
    const plain = line
        .replace(/\*\*|__/g, '')
        .replace(/^[#>*\-\s]+/, '')
        .replace(/^(name|title)\s*:\s*/i, '')
        .replace(/^["'`“‘]+|["'`”’.]+$/g, '')
        .trim();
    return oneLine(plain, MAX_SESSION_NAME);
}

/** The most characters of the conversation that go into the prompt for a name. */
const MAX_EXCERPT = 12_000;
/** The most characters of one message in the excerpt. */
const MAX_MESSAGE = 1500;

/**
 * Returns the prompt that asks the agent for a session name. The prompt has the user prompts and the agent answers of
 * the session, without tool calls. A long session gives its first prompt and its newest messages.
 */
export function sessionNamePrompt(items: readonly ChatItem[]): string {
    const messages = items
        .filter(item => item.kind === 'user' || item.kind === 'agent')
        .map(item => `${item.kind === 'user' ? 'User' : 'Agent'}: ${clip(item.text)}`)
        .filter(line => line.length > 'User: '.length);
    const first = messages[0];
    const newest: string[] = [];
    let size = first ? first.length : 0;
    for (let index = messages.length - 1; index > 0; index--) {
        const message = messages[index] as string;
        if (size + message.length > MAX_EXCERPT) break;
        newest.unshift(message);
        size += message.length;
    }
    const skipped = messages.length - 1 - newest.length;
    const excerpt = [first, skipped > 0 ? `[${skipped} earlier messages are not shown]` : undefined, ...newest].filter(Boolean).join('\n\n');
    return [
        'Below is a conversation between a user and a coding agent. The user saves the conversation to continue it later.',
        'Write a name for the conversation, so that the user can find it in a list.',
        '',
        'Rules:',
        '- Use 3 to 7 words.',
        '- Name the task or the subject, for example "Fix flaky login test" or "Plan the billing migration".',
        '- Use sentence case. Do not use quotes, a period, or Markdown.',
        '- Write only the name, on one line.',
        '',
        '<conversation>',
        excerpt || '(The conversation has no messages yet.)',
        '</conversation>'
    ].join('\n');
}

function clip(text: string): string {
    const value = text.trim();
    return value.length > MAX_MESSAGE ? `${value.slice(0, MAX_MESSAGE)}…` : value;
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function time(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Returns a valid pin from stored data, or undefined. */
export function normalizePinnedSession(value: unknown): PinnedSession | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const entry = value as Record<string, unknown>;
    const id = text(entry.id);
    const transcript = text(entry.transcript);
    const sessionId = text(entry.sessionId) ?? (transcript ? sessionIdOf(transcript) : undefined);
    const cwd = text(entry.cwd);
    const pinnedAt = time(entry.pinnedAt);
    if (!id || !transcript || !sessionId || !SESSION_ID.test(sessionId) || !cwd || !pinnedAt) return undefined;
    const resumedAt = time(entry.resumedAt);
    const unpinnedAt = time(entry.unpinnedAt);
    return {
        id,
        sessionId,
        transcript,
        name: text(entry.name) ?? 'Pinned session',
        ...(entry.naming === true ? { naming: true } : {}),
        cwd,
        ...(text(entry.repoPath) ? { repoPath: text(entry.repoPath) } : {}),
        ...(text(entry.branch) ? { branch: text(entry.branch) } : {}),
        ...(text(entry.agentId) ? { agentId: text(entry.agentId) } : {}),
        pinnedAt,
        ...(resumedAt ? { resumedAt } : {}),
        ...(unpinnedAt ? { unpinnedAt } : {})
    };
}

/** Returns true when an unpinned session is older than UNPINNED_KEEP_DAYS days. A pin never expires. */
export function pinExpired(pin: PinnedSession, now: number): boolean {
    return pin.unpinnedAt !== undefined && now - pin.unpinnedAt > UNPINNED_KEEP_DAYS * DAY_MS;
}

/** Returns valid session tags from stored data. A session without tags has no entry. */
export function normalizeSessionTags(value: unknown): SessionTags {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: SessionTags = {};
    for (const [sessionId, tags] of Object.entries(value as Record<string, unknown>)) {
        const clean = normalizeTags(tags);
        if (SESSION_ID.test(sessionId) && clean.length > 0) result[sessionId] = clean;
    }
    return result;
}

/**
 * Returns all tags with the number of sessions that have each tag, in alphabetical order. Only the sessions in
 * `sessionIds` count.
 */
export function tagCounts(tags: SessionTags, sessionIds: Iterable<string>): [string, number][] {
    const counts = new Map<string, number>();
    for (const id of new Set(sessionIds)) {
        for (const tag of tags[id] ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
}

/** Returns true when the session has each tag of the filter. An empty filter matches each session. */
export function hasTags(tags: SessionTags, sessionId: string, filter: readonly string[]): boolean {
    const own = (tags[sessionId] ?? []).map(tag => tag.toLowerCase());
    return filter.every(tag => own.includes(tag.toLowerCase()));
}

/** Sorts the pins: the newest pin or resume first. */
export function sortPins(pins: readonly PinnedSession[]): PinnedSession[] {
    return [...pins].sort((a, b) => (b.resumedAt ?? b.pinnedAt) - (a.resumedAt ?? a.pinnedAt));
}

/** Returns the pin of a transcript, by its session ID. */
export function pinOfTranscript(pins: readonly PinnedSession[], transcript: string | undefined): PinnedSession | undefined {
    const sessionId = transcript ? sessionIdOf(transcript) : undefined;
    return sessionId ? pins.find(pin => pin.sessionId === sessionId) : undefined;
}
