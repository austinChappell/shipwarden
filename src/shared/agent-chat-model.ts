/**
 * The chat model of an agent tab. The model does not depend on the agent. One adapter for each transcript format
 * makes the items (`agent-chat-claude.ts` and `agent-chat-codex.ts`).
 */

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
    /** The ID of the tool call. The result has the same ID. */
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

/** Shortens a long detail or result. */
export function clip(value: string): string {
    return value.length > MAX_DETAIL_LENGTH ? `${value.slice(0, MAX_DETAIL_LENGTH)}…` : value;
}

/** Returns the time of a transcript entry in milliseconds, from its "timestamp" field. */
export function timeOf(entry: Record<string, unknown>): number | undefined {
    const at = Date.parse(String(entry.timestamp ?? ''));
    return Number.isFinite(at) ? at : undefined;
}

/** Returns the text blocks of a tool result as one text. The content is a string or a list of blocks. */
export function resultText(content: unknown): string | undefined {
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
 * Adds items to a copy of a chat list. The adapters use it.
 * - An item with a known ID is ignored, so a line that the reader gets two times shows one time.
 * - `finishTool` sets the result of a tool call of this read or of an earlier read.
 */
export class ChatBuilder {
    readonly items: ChatItem[];
    private readonly ids: Set<string>;
    private readonly toolIndex = new Map<string, number>();

    constructor(items: readonly ChatItem[]) {
        this.items = [...items];
        this.ids = new Set(this.items.map(item => item.id));
        this.items.forEach((item, index) => item.kind === 'tool' && this.toolIndex.set(item.id, index));
    }

    push(item: ChatItem): void {
        if (this.ids.has(item.id)) return;
        this.ids.add(item.id);
        if (item.kind === 'tool') this.toolIndex.set(item.id, this.items.length);
        this.items.push(item);
    }

    /** Sets the status and the result of a tool call. A result of an unknown tool call is ignored. */
    finishTool(id: string, status: 'ok' | 'error', result: string | undefined): void {
        const index = this.toolIndex.get(id);
        if (index === undefined) return;
        this.items[index] = { ...(this.items[index] as ChatToolItem), status, result };
    }
}
