import { addClaudeLines } from './agent-chat-claude';
import { addCodexLines } from './agent-chat-codex';
import { ChatBuilder, type ChatItem } from './agent-chat-model';
import { transcriptAgentOf } from './agents';

export { promptText } from './agent-chat-claude';
export type { ChatAgentItem, ChatItem, ChatToolItem, ChatUserItem } from './agent-chat-model';

/** The transcript formats that the chat can read. Each format has one adapter. */
export type ChatFormat = 'claude' | 'codex';

/** Returns the chat format of a transcript file, or undefined when the chat cannot read the file. */
export function chatFormatOf(file: string | undefined): ChatFormat | undefined {
    return transcriptAgentOf(file);
}

/** The agent names for the chat text, by format. */
export const CHAT_AGENT_NAMES: Record<ChatFormat, string> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * Adds the entries of transcript lines (JSON lines) to the chat items. Returns a new list.
 * - The adapter of `format` reads the lines. The default format is the Claude Code transcript.
 * - A tool result updates the status of its tool call.
 * - An entry with a known ID is ignored, so a line that the reader gets two times shows one time.
 */
export function addTranscriptLines(items: readonly ChatItem[], lines: readonly string[], format: ChatFormat = 'claude'): ChatItem[] {
    const chat = new ChatBuilder(items);
    if (format === 'codex') addCodexLines(chat, lines);
    else addClaudeLines(chat, lines);
    return chat.items;
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
