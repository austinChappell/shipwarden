import { describeTool } from './agents';
import { type ChatBuilder, clip, resultText, timeOf } from './agent-chat-model';

/** The tags of the messages that Claude Code adds for itself, not for the user. */
const HIDDEN_TAGS = /^<(local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-stdout|bash-stderr|user-memory-input)>/;

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

/**
 * Adds the entries of Claude Code transcript lines (JSON lines) to the chat.
 * - The function ignores lines that are not JSON, entries of subagents (sidechain), and messages that Claude Code adds
 *   for itself (meta messages, command output, and reminders).
 * - A tool result updates the status of its tool call.
 * - The ID of a user item is the entry UUID. The ID of an agent text is the entry UUID and the block index.
 */
export function addClaudeLines(chat: ChatBuilder, lines: readonly string[]): void {
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
                if (text && uuid) chat.push({ kind: 'user', id: uuid, text, at });
                continue;
            }
            if (!Array.isArray(content)) continue;
            const texts: string[] = [];
            const images: string[] = [];
            for (const raw of content) {
                const block = (raw ?? {}) as Record<string, unknown>;
                if (block.type === 'tool_result') {
                    chat.finishTool(String(block.tool_use_id ?? ''), block.is_error === true ? 'error' : 'ok', resultText(block.content));
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
            if ((text || images.length > 0) && uuid) chat.push({ kind: 'user', id: uuid, text, ...(images.length > 0 ? { images } : {}), at });
            continue;
        }

        if (!Array.isArray(content)) continue;
        content.forEach((raw, index) => {
            const block = (raw ?? {}) as Record<string, unknown>;
            if (block.type === 'text') {
                const text = String(block.text ?? '').trim();
                if (text && uuid) chat.push({ kind: 'agent', id: `${uuid}:${index}`, text, at });
            } else if (block.type === 'tool_use' && typeof block.id === 'string') {
                const name = String(block.name ?? 'tool');
                const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
                chat.push({ kind: 'tool', id: block.id, name, summary: describeTool(name, input), detail: toolDetail(input), status: 'running', at });
            }
        });
    }
}
