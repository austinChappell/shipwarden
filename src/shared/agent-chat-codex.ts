import { describeTool, oneLine } from './agents';
import { type ChatBuilder, type ChatToolItem, clip, resultText, timeOf } from './agent-chat-model';

/*
 * A Codex session file (`rollout-<time>-<id>.jsonl`) has one JSON entry on each line. The chat reads only the
 * "item_completed" events: `{ type: "event_msg", payload: { type: "item_completed", item: { type, id, ... } } }`.
 * These items are the items that the Codex TUI shows. Codex writes an item when it is complete, so a tool call shows
 * with its result. The tab shows the running tool from the hooks ("Working" line).
 * The other entries (response items, reasoning, token counts, and turn events) are for the model or for the counters.
 * The subagents of Codex (for example the approval reviewer) write their own session files, so their items do not
 * come here.
 */

type Item = Record<string, unknown>;

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.map(record) : [];
}

/** Returns the last part of a path or a file URL. */
function fileName(value: unknown): string | undefined {
    return text(value)
        ?.replace(/^file:\/\//, '')
        .split('/')
        .filter(Boolean)
        .pop();
}

/** Returns the text blocks of a message item as one text. Codex uses the block types "text" and "Text". */
function blockText(content: unknown): string {
    return list(content)
        .filter(block => block.type === 'text' || block.type === 'Text' || block.type === 'output_text')
        .map(block => String(block.text ?? '').trim())
        .filter(Boolean)
        .join('\n\n');
}

/**
 * Returns the shell script of a command. Codex runs a command as a list of words, for example
 * ["/bin/zsh", "-lc", "npm test"]. The script is the last word after "-c" or "-lc".
 */
function commandText(command: unknown): string | undefined {
    if (typeof command === 'string') return text(command);
    if (!Array.isArray(command)) return undefined;
    const words = command.map(String);
    const flag = words.findIndex(word => /^-[a-z]*c$/.test(word));
    return text(flag >= 0 && flag + 1 < words.length ? words[flag + 1] : words.join(' '));
}

/**
 * Returns the summary of a command from the parts that Codex parsed ("parsed_cmd"). Codex marks each part as "read",
 * "search", "list_files", or "unknown". A command with an unknown part shows as "Running <command>".
 */
function commandSummary(parts: Record<string, unknown>[], command: string | undefined): string {
    const kinds = new Set(parts.map(part => String(part.type)));
    const only = (kind: string) => kinds.size === 1 && kinds.has(kind);
    if (only('read')) {
        const names = [...new Set(parts.map(part => fileName(part.name ?? part.path)).filter(Boolean))];
        if (names.length === 1) return `Reading ${names[0]}`;
        return names.length > 1 ? `Reading ${names.length} files` : 'Reading files';
    }
    if (only('search')) {
        const query = text(parts[0].query);
        return query ? `Searching for "${oneLine(query, 40)}"` : 'Searching the code';
    }
    if (only('list_files')) return `Listing ${fileName(parts[0].path) ?? 'files'}`;
    if (parts.length > 0 && [...kinds].every(kind => kind === 'read' || kind === 'search' || kind === 'list_files')) {
        return 'Reading the code';
    }
    return describeTool('exec_command', { cmd: command });
}

function commandItem(item: Item, at: number | undefined): ChatToolItem {
    const command = commandText(item.command);
    const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
    const failed = item.status === 'failed' || (exitCode !== undefined && exitCode !== 0);
    const output = text(item.aggregated_output);
    return {
        kind: 'tool',
        id: String(item.id),
        name: 'exec_command',
        summary: commandSummary(list(item.parsed_cmd), command),
        detail: command ? clip(command) : undefined,
        status: failed ? 'error' : 'ok',
        result: output ? clip(output) : failed && exitCode !== undefined ? `Exit code ${exitCode}` : undefined,
        at
    };
}

/** A file change of an "apply_patch" call. "changes" has one entry for each file path. */
function fileChangeItem(item: Item, at: number | undefined): ChatToolItem {
    const changes = Object.entries(record(item.changes)).map(([path, value]): Record<string, unknown> & { path: string } => ({ ...record(value), path }));
    let summary = `Editing ${changes.length} files`;
    if (changes.length === 1) {
        const name = fileName(changes[0].path) ?? 'a file';
        summary = changes[0].type === 'add' ? `Creating ${name}` : changes[0].type === 'delete' ? `Deleting ${name}` : `Editing ${name}`;
    } else if (changes.length === 0) {
        summary = 'Editing files';
    }
    const diffs = changes
        .map(change => text(change.unified_diff) ?? text(change.content))
        .filter(Boolean)
        .join('\n');
    const failed = item.status === 'failed';
    const result = (failed ? text(item.stderr) : undefined) ?? diffs;
    return {
        kind: 'tool',
        id: String(item.id),
        name: 'apply_patch',
        summary,
        detail: changes.length > 0 ? clip(changes.map(change => change.path).join('\n')) : undefined,
        status: failed ? 'error' : 'ok',
        result: result ? clip(result) : undefined,
        at
    };
}

function mcpItem(item: Item, at: number | undefined): ChatToolItem {
    const server = text(item.server) ?? 'mcp';
    const tool = text(item.tool) ?? 'tool';
    const args = record(item.arguments);
    const result = record(item.result);
    const title = text(args.title);
    return {
        kind: 'tool',
        id: String(item.id),
        name: `mcp__${server}__${tool}`,
        summary: title ? oneLine(title, 70) : describeTool(`mcp__${server}__${tool}`),
        detail: Object.keys(args).length > 0 ? clip(JSON.stringify(args, null, 2)) : undefined,
        status: item.status === 'failed' || result.isError === true ? 'error' : 'ok',
        result: resultText(result.content) ?? text(item.error),
        at
    };
}

/** A built-in tool of Codex that is not a shell command, for example "web.search". */
function extensionItem(item: Item, at: number | undefined): ChatToolItem {
    const kind = text(item.kind) ?? 'tool';
    const base = { kind: 'tool' as const, id: String(item.id), name: kind, status: 'ok' as const, at };
    if (kind === 'web.search') {
        const action = record(item.action);
        const url = text(action.url);
        const query = text(item.query);
        const results = list(item.results)
            .map(result => text(result.url))
            .filter(Boolean)
            .join('\n');
        if (action.type === 'openPage' && url) {
            let host = url;
            try {
                host = new URL(url).host;
            } catch {}
            return { ...base, summary: `Reading ${host}`, detail: clip(url), result: results ? clip(results) : undefined };
        }
        return {
            ...base,
            summary: describeTool('web_search', { query }),
            detail: query ? clip(query) : undefined,
            result: results ? clip(results) : undefined
        };
    }
    if (kind === 'clock.sleep') return { ...base, summary: 'Waiting' };
    return { ...base, summary: `Using ${kind}` };
}

/**
 * Adds the items of Codex session file lines (JSON lines) to the chat.
 * - The function ignores lines that are not JSON and entries that are not "item_completed" events.
 * - It ignores reasoning and context compaction items.
 * - The ID of each chat item is the ID of the Codex item.
 * - A user prompt keeps its image marks ("[Image #1]"), because the images are files that the chat cannot show.
 */
export function addCodexLines(chat: ChatBuilder, lines: readonly string[]): void {
    for (const line of lines) {
        if (!line.includes('"item_completed"')) continue;
        let entry: Record<string, unknown>;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        const payload = record(entry.payload);
        if (entry.type !== 'event_msg' || payload.type !== 'item_completed') continue;
        const item = record(payload.item);
        const id = text(item.id);
        if (!id) continue;
        const at = timeOf(entry);
        switch (item.type) {
            case 'UserMessage': {
                const prompt = blockText(item.content);
                if (prompt) chat.push({ kind: 'user', id, text: prompt, at });
                break;
            }
            case 'AgentMessage': {
                const answer = blockText(item.content);
                if (answer) chat.push({ kind: 'agent', id, text: answer, at });
                break;
            }
            case 'CommandExecution':
                chat.push(commandItem(item, at));
                break;
            case 'FileChange':
                chat.push(fileChangeItem(item, at));
                break;
            case 'McpToolCall':
                chat.push(mcpItem(item, at));
                break;
            case 'Extension':
                chat.push(extensionItem(item, at));
                break;
            case 'ImageView': {
                const path = text(item.path)?.replace(/^file:\/\//, '');
                chat.push({ kind: 'tool', id, name: 'view_image', summary: `Looking at ${fileName(path) ?? 'an image'}`, detail: path, status: 'ok', at });
                break;
            }
        }
    }
}
