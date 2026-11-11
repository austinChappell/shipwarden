import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { countedTokens } from '@shared/automations';

/** One response of the model in a transcript. */
interface Response {
    at: number;
    tokens: number;
}

/** The parsed part of one transcript file. */
interface FileState {
    /** The number of bytes that the counter read. A transcript only grows, so the next read starts here. */
    offset: number;
    /** An incomplete last line, without its end. The next read completes it. */
    rest: string;
    /** The responses by message ID. Claude Code writes one line for each content block, with the same usage on each. */
    responses: Map<string, Response>;
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
        responses.set(message.id, { at, tokens: countedTokens(message.usage) });
    }
}

/**
 * Counts the tokens of Claude Code sessions from their transcript files (JSON lines). The counter keeps what it read,
 * and reads only the new end of a file at the next call. Only files in the Claude Code data folder can be read.
 */
export class TokenCounter {
    private readonly files = new Map<string, FileState>();

    constructor(private readonly allowedRoots: readonly string[] = defaultRoots()) {}

    /**
     * Returns the tokens of the responses in the time from `from` to `to` (milliseconds, `to` is open). The count adds
     * the transcripts of the subagents of the session (`<session>/subagents/*.jsonl`).
     */
    async count(file: string, from: number, to?: number): Promise<number> {
        const resolved = path.resolve(file);
        if (!resolved.endsWith('.jsonl') || !this.allowedRoots.some(root => resolved.startsWith(`${root}${path.sep}`))) {
            throw new Error('The transcript is not in the Claude Code data folder.');
        }
        const files = [resolved, ...(await subagentFiles(resolved))];
        let total = 0;
        for (const item of files) {
            for (const response of (await this.read(item)).responses.values()) {
                if (response.at >= from && (to === undefined || response.at < to)) total += response.tokens;
            }
        }
        return total;
    }

    private async read(file: string): Promise<FileState> {
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
                addResponses(state.responses, lines);
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
function defaultRoots(): string[] {
    const roots = [path.join(os.homedir(), '.claude')];
    if (process.env.CLAUDE_CONFIG_DIR) roots.push(path.resolve(process.env.CLAUDE_CONFIG_DIR));
    return roots;
}
