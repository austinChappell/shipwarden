import { describeTool } from './agents';

/** A prompt of the user. */
export interface ChatUserItem {
    kind: 'user';
    id: string;
    /** The text without the image marks ("[Image #1]"). It can be empty when the prompt has only images. */
    text: string;
    /** The images of the prompt as data URLs. */
    images?: string[];
    at?: number;
}

/** A text answer of the agent. The text is Markdown. */
export interface ChatAgentItem {
    kind: 'agent';
    id: string;
    text: string;
    at?: number;
}

/** A tool call of the agent and its result. */
export interface ChatToolItem {
    kind: 'tool';
    /** The tool_use ID. The result has the same ID. */
    id: string;
    name: string;
    /** A short text for people, for example "Editing App.tsx". */
    summary: string;
    /** The most useful part of the input, for example the command or the file path. */
    detail?: string;
    /** "running" until the result comes. */
    status: 'running' | 'ok' | 'error';
    /** The start of the result text. */
    result?: string;
    at?: number;
}

export type ChatItem = ChatUserItem | ChatAgentItem | ChatToolItem;

/** The maximum length of a tool detail or a tool result in the chat. The rest is in the terminal. */
const MAX_DETAIL_LENGTH = 4000;

/** The tags of the messages that Claude Code adds for itself, not for the user. */
const HIDDEN_TAGS = /^<(local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-stdout|bash-stderr|user-memory-input)>/;

function clip(value: string): string {
    return value.length > MAX_DETAIL_LENGTH ? `${value.slice(0, MAX_DETAIL_LENGTH)}…` : value;
}

function timeOf(entry: Record<string, unknown>): number | undefined {
    const at = Date.parse(String(entry.timestamp ?? ''));
    return Number.isFinite(at) ? at : undefined;
}

/**
 * Returns the text of a user prompt for the chat, or undefined for a message that the user did not write.
 * A slash command shows as the command and its arguments, for example "/review 12".
 */
export function promptText(raw: string): string | undefined {
    const text = raw.trim();
    if (!text || HIDDEN_TAGS.test(text)) return undefined;
    const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
    if (command) {
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
        const name = command[1].trim();
        return args ? `${name} ${args}` : name;
    }
    if (text.startsWith('<command-message>')) return undefined;
    return text;
}

/** The image types that the chat shows. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The mark of an image in the text of a prompt, for example "[Image #1]". */
const IMAGE_MARK = /\[Image #\d+\]/g;

/** Returns the data URL of a base64 image block source, or undefined for another source. */
function imageUrl(source: unknown): string | undefined {
    const value = (source ?? {}) as Record<string, unknown>;
    if (value.type !== 'base64' || typeof value.data !== 'string' || !IMAGE_TYPES.has(String(value.media_type))) return undefined;
    return /^[A-Za-z0-9+/=]+$/.test(value.data) ? `data:${value.media_type};base64,${value.data}` : undefined;
}

/** Returns the useful part of a tool input, for example the command of Bash. */
function toolDetail(input: Record<string, unknown>): string | undefined {
    for (const key of ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'prompt', 'filePath', 'path']) {
        const value = input[key];
        if (typeof value === 'string' && value.trim()) return clip(value.trim());
    }
    return undefined;
}

/** Returns the text of a tool result. The content is a string or a list of blocks. */
function resultText(content: unknown): string | undefined {
    if (typeof content === 'string') return content.trim() ? clip(content.trim()) : undefined;
    if (!Array.isArray(content)) return undefined;
    const text = content
        .map(block =>
            block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text'
                ? String((block as Record<string, unknown>).text ?? '')
                : ''
        )
        .filter(Boolean)
        .join('\n')
        .trim();
    return text ? clip(text) : undefined;
}

/**
 * Adds the entries of Claude Code transcript lines (JSON lines) to the chat items. Returns a new list.
 * - The function ignores lines that are not JSON, entries of subagents (sidechain), and messages that Claude Code adds
 *   for itself (meta messages, command output, and reminders).
 * - A tool result updates the status of its tool call.
 * - An entry with a known UUID is ignored, so a line that the reader gets two times shows one time.
 */
export function addTranscriptLines(items: readonly ChatItem[], lines: readonly string[]): ChatItem[] {
    const next = [...items];
    const ids = new Set(next.map(item => item.id));
    const toolIndex = new Map<string, number>();
    next.forEach((item, index) => item.kind === 'tool' && toolIndex.set(item.id, index));

    const push = (item: ChatItem) => {
        if (ids.has(item.id)) return;
        ids.add(item.id);
        if (item.kind === 'tool') toolIndex.set(item.id, next.length);
        next.push(item);
    };

    for (const line of lines) {
        if (!line.includes('"message"')) continue;
        let entry: Record<string, unknown>;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isSidechain === true || entry.isMeta === true) continue;
        if (entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) continue;
        const message = entry.message as Record<string, unknown> | undefined;
        if (!message) continue;
        const uuid = String(entry.uuid ?? '');
        const at = timeOf(entry);
        const content = message.content;

        if (entry.type === 'user') {
            if (typeof content === 'string') {
                const text = promptText(content);
                if (text && uuid) push({ kind: 'user', id: uuid, text, at });
                continue;
            }
            if (!Array.isArray(content)) continue;
            const texts: string[] = [];
            const images: string[] = [];
            for (const raw of content) {
                const block = (raw ?? {}) as Record<string, unknown>;
                if (block.type === 'tool_result') {
                    const index = toolIndex.get(String(block.tool_use_id ?? ''));
                    if (index === undefined) continue;
                    const tool = next[index] as ChatToolItem;
                    next[index] = { ...tool, status: block.is_error === true ? 'error' : 'ok', result: resultText(block.content) };
                } else if (block.type === 'text') {
                    const text = promptText(String(block.text ?? ''));
                    if (text) texts.push(text);
                } else if (block.type === 'image') {
                    const url = imageUrl(block.source);
                    if (url) images.push(url);
                }
            }
            // Claude Code puts a mark such as "[Image #1]" in the text for each image. The chat shows the image instead.
            const text = (images.length > 0 ? texts.map(item => item.replace(IMAGE_MARK, '')) : texts)
                .map(item => item.trim())
                .filter(Boolean)
                .join('\n\n');
            if ((text || images.length > 0) && uuid) push({ kind: 'user', id: uuid, text, ...(images.length > 0 ? { images } : {}), at });
            continue;
        }

        if (!Array.isArray(content)) continue;
        content.forEach((raw, index) => {
            const block = (raw ?? {}) as Record<string, unknown>;
            if (block.type === 'text') {
                const text = String(block.text ?? '').trim();
                if (text && uuid) push({ kind: 'agent', id: `${uuid}:${index}`, text, at });
            } else if (block.type === 'tool_use' && typeof block.id === 'string') {
                const name = String(block.name ?? 'tool');
                const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
                push({ kind: 'tool', id: block.id, name, summary: describeTool(name, input), detail: toolDetail(input), status: 'running', at });
            }
        });
    }
    return next;
}

/** The transcript part that the main process reads. */
export interface TranscriptChunk {
    /** The complete lines after the offset of the request. */
    lines: string[];
    /** The offset for the next read: the end of the last complete line. */
    offset: number;
    /** True when the reader skipped the start of a long file. The chat then shows only the newest part. */
    truncated: boolean;
}
