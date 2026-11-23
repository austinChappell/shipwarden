import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { transcriptAgentOf } from '@shared/agents';
import { cacheReadTokens, countedTokens, type TokenCount } from '@shared/automations';

/** One response of the model in a transcript. */
interface Response {
    at: number;
    tokens: number;
    cacheReads: number;
}

/** The parsed part of one transcript file. */
interface FileState {
    /** The number of bytes that the counter read. A transcript only grows, so the next read starts here. */
    offset: number;
    /** An incomplete last line, without its end. The next read completes it. */
    rest: string;
    /** The responses by message ID. Claude Code writes one line for each content block, with the same usage on each. */
    responses: Map<string, Response>;
    /** The last total of a Codex session file. Codex writes totals, so each response is the change from the last total. */
    codexTotal?: TokenCount;
}

/** Adds the responses of complete JSON lines to the map. A line that is not a response is ignored. */
export function addResponses(responses: Map<string, Response>, lines: readonly string[]): void {
    for (const line of lines) {
        if (!line.includes('"usage"')) continue;
        let entry: Record<string, unknown>;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        const message = entry.message as Record<string, unknown> | undefined;
        if (entry.type !== 'assistant' || !message || typeof message.id !== 'string') continue;
        const at = Date.parse(String(entry.timestamp ?? ''));
        if (!Number.isFinite(at)) continue;
        responses.set(message.id, { at, tokens: countedTokens(message.usage), cacheReads: cacheReadTokens(message.usage) });
    }
}

/**
 * Reads the tokens of one "token_count" event of a Codex session file. Codex writes the total of the session in
 * "info.total_token_usage". The input tokens include the cache reads, and the output tokens include the reasoning.
 * Returns the tokens that count (input without cache reads, and output) and the cache reads.
 */
export function codexTotalOf(entry: Record<string, unknown>): TokenCount | undefined {
    const payload = entry.payload as Record<string, unknown> | undefined;
    if (entry.type !== 'event_msg' || payload?.type !== 'token_count') return undefined;
    const usage = (payload.info as Record<string, unknown> | null | undefined)?.total_token_usage as Record<string, unknown> | undefined;
    if (!usage) return undefined;
    const number = (key: string) => (typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? (usage[key] as number) : 0);
    const cacheReads = number('cached_input_tokens');
    return { tokens: Math.max(number('input_tokens') - cacheReads, 0) + number('output_tokens'), cacheReads };
}

/**
 * Adds the responses of the complete JSON lines of a Codex session file to the state.
 * Each "token_count" event with a larger total is one response. Its count is the change from the last total.
 * Codex can write the same total again, for example for a new plan usage. Such an event adds nothing.
 */
export function addCodexResponses(state: Pick<FileState, 'responses' | 'codexTotal'>, lines: readonly string[]): void {
    for (const line of lines) {
        if (!line.includes('"token_count"')) continue;
        let entry: Record<string, unknown>;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        const total = codexTotalOf(entry);
        const at = Date.parse(String(entry.timestamp ?? ''));
        if (!total || !Number.isFinite(at)) continue;
        const last = state.codexTotal ?? { tokens: 0, cacheReads: 0 };
        const tokens = total.tokens - last.tokens;
        const cacheReads = total.cacheReads - last.cacheReads;
        state.codexTotal = total;
        if (tokens <= 0 && cacheReads <= 0) continue;
        state.responses.set(String(state.responses.size), { at, tokens: Math.max(tokens, 0), cacheReads: Math.max(cacheReads, 0) });
    }
}

/**
 * Counts the tokens of Claude Code and Codex sessions from their transcript files (JSON lines). The counter keeps what it read,
 * and reads only the new end of a file at the next call. Only files in the Claude Code and Codex data folders can be read.
 * A Codex session file has the name `rollout-<time>-<id>.jsonl` (see `transcriptAgentOf`).
 */
export class TokenCounter {
    private readonly files = new Map<string, FileState>();
    /** The last read of each file. A new read of a file starts after the last read, so two reads do not mix the same bytes. */
    private readonly reads = new Map<string, Promise<FileState>>();

    constructor(private readonly allowedRoots: readonly string[] = [...claudeDataRoots(), ...codexDataRoots()]) {}

    /**
     * Returns the tokens and the cache reads of the responses in the time from `from` to `to` (milliseconds, `to` is
     * open). The count adds the transcripts of the subagents of the session (`<session>/subagents/*.jsonl`).
     */
    async count(file: string, from: number, to?: number): Promise<TokenCount> {
        const resolved = path.resolve(file);
        if (!resolved.endsWith('.jsonl') || !this.allowedRoots.some(root => resolved.startsWith(`${root}${path.sep}`))) {
            throw new Error('The transcript is not in the Claude Code or Codex data folder.');
        }
        // Codex has no subagent folder next to a session file.
        const files = transcriptAgentOf(resolved) === 'codex' ? [resolved] : [resolved, ...(await subagentFiles(resolved))];
        const total: TokenCount = { tokens: 0, cacheReads: 0 };
        for (const item of files) {
            for (const response of (await this.read(item)).responses.values()) {
                if (response.at >= from && (to === undefined || response.at < to)) {
                    total.tokens += response.tokens;
                    total.cacheReads += response.cacheReads;
                }
            }
        }
        return total;
    }

    private read(file: string): Promise<FileState> {
        const last = this.reads.get(file) ?? Promise.resolve(undefined);
        const next = last.catch(() => undefined).then(() => this.readNew(file));
        this.reads.set(file, next);
        return next;
    }

    private async readNew(file: string): Promise<FileState> {
        let state = this.files.get(file);
        const size = await fs.stat(file).then(
            stat => stat.size,
            () => 0
        );
        if (!state || size < state.offset) {
            // A new file, or a file that is shorter than before (rewritten): read it from the start.
            state = { offset: 0, rest: '', responses: new Map() };
            this.files.set(file, state);
        }
        if (size > state.offset) {
            const handle = await fs.open(file, 'r');
            try {
                const buffer = Buffer.alloc(size - state.offset);
                await handle.read(buffer, 0, buffer.length, state.offset);
                state.offset = size;
                const lines = (state.rest + buffer.toString('utf8')).split('\n');
                state.rest = lines.pop() ?? '';
                if (transcriptAgentOf(file) === 'codex') addCodexResponses(state, lines);
                else addResponses(state.responses, lines);
            } finally {
                await handle.close();
            }
        }
        return state;
    }
}

/** The transcripts of the subagents of a session, if any. */
async function subagentFiles(file: string): Promise<string[]> {
    const folder = path.join(file.slice(0, -'.jsonl'.length), 'subagents');
    try {
        return (await fs.readdir(folder)).filter(name => name.endsWith('.jsonl')).map(name => path.join(folder, name));
    } catch {
        return [];
    }
}

/** The Claude Code data folders: ~/.claude, and CLAUDE_CONFIG_DIR when it is set. */
export function claudeDataRoots(): string[] {
    const roots = [path.join(os.homedir(), '.claude')];
    if (process.env.CLAUDE_CONFIG_DIR) roots.push(path.resolve(process.env.CLAUDE_CONFIG_DIR));
    return roots;
}

/** The Codex data folder: CODEX_HOME when it is set, else ~/.codex. Codex writes its session files below it. */
export function codexDataRoots(): string[] {
    return [process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex')];
}
