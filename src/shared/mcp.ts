import type { BranchStatus, PullRequest, PullRequestChange } from './github';

/**
 * The ShipWarden MCP server: the tools that agents can call, and the approvals of the write tools.
 * The functions of this module use no Electron API. The main process and the page both use them.
 */

/** The name of the server in the MCP config of an agent. The tools show as `mcp__shipwarden__<tool>` in Claude Code. */
export const MCP_SERVER_NAME = 'shipwarden';

/** The path of the MCP endpoint on the local server. */
export const MCP_PATH = '/mcp';

/**
 * The tools that read data. They need no approval. watch_pull_request is in this list, because it only sends messages
 * to the agent that calls it.
 */
export const MCP_READ_TOOLS = [
    'list_worktrees',
    'get_overlaps',
    'get_task',
    'get_pull_request',
    'get_checks',
    'watch_pull_request',
    'read_page',
    'screenshot'
] as const;

/** The tools that change something or start an agent. Each one needs approval the first time in a worktree. */
export const MCP_WRITE_TOOLS = [
    'ask_agent',
    'set_task_status',
    'create_pull_request',
    'update_pull_request',
    'reply_to_comment',
    'open_page',
    'click',
    'type'
] as const;

export type McpReadTool = (typeof MCP_READ_TOOLS)[number];
export type McpWriteTool = (typeof MCP_WRITE_TOOLS)[number];
export type McpToolName = McpReadTool | McpWriteTool;

/** Returns true when the tool needs approval. */
export function isWriteTool(name: string): name is McpWriteTool {
    return (MCP_WRITE_TOOLS as readonly string[]).includes(name);
}

/** The approved write tools of each worktree, by the worktree path. */
export type McpApprovals = Record<string, McpWriteTool[]>;

/** Returns valid approvals. A wrong value gives an empty object. Unknown tools and duplicates go away. */
export function normalizeApprovals(value: unknown): McpApprovals {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: McpApprovals = {};
    for (const [worktree, tools] of Object.entries(value as Record<string, unknown>)) {
        if (!worktree.startsWith('/') || !Array.isArray(tools)) continue;
        const valid = [...new Set(tools.filter((tool): tool is McpWriteTool => typeof tool === 'string' && isWriteTool(tool)))];
        if (valid.length > 0) result[worktree] = valid.sort();
    }
    return result;
}

const WRITE_TOOL_LABELS: Record<McpWriteTool, string> = {
    ask_agent: 'Ask the agent of another worktree',
    set_task_status: 'Change the status of the task',
    create_pull_request: 'Create a pull request',
    update_pull_request: 'Change the pull request',
    reply_to_comment: 'Reply to a review comment',
    open_page: 'Open a page in the browser',
    click: 'Click in the browser',
    type: 'Type in the browser'
};

/** The label of a write tool for the approval dialog and Settings › Agents. */
export function writeToolLabel(tool: McpWriteTool): string {
    return WRITE_TOOL_LABELS[tool];
}

/** The pull request events that watch_pull_request can send to the agent. They are the automation triggers with the same names. */
export const WATCH_EVENTS = ['ci.failed', 'pr.conflict', 'pr.comment'] as const;
export type WatchEvent = (typeof WATCH_EVENTS)[number];

/**
 * A watch of watch_pull_request. ShipWarden types a message into the agent session when an event of the pull request
 * of the worktree occurs. The watch ends when the agent tab closes, when the pull request is merged or closed, or when
 * the agent stops it.
 */
export interface McpWatch {
    id: string;
    /** The worktree of the agent. */
    worktree: string;
    /** The terminal session of the agent. The messages go to this session only. */
    sessionId: string;
    events: WatchEvent[];
    /** The number of the pull request when the watch started. */
    number: number;
    createdAt: number;
}

/**
 * The environment variable with the MCP token of an agent session. Codex and opencode read the token from it, so the
 * token is not in the command line.
 */
export const MCP_TOKEN_ENV = 'SHIPWARDEN_MCP_TOKEN';

/**
 * Returns the MCP config that Claude Code gets with --mcp-config. The server uses the Streamable HTTP transport.
 * The token in the header identifies the session and its worktree.
 */
export function mcpConfig(url: string, token: string): { mcpServers: Record<string, { type: 'http'; url: string; headers: Record<string, string> }> } {
    return { mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } };
}

/**
 * Returns the Gemini CLI settings of an agent session: the hook settings of ShipWarden and the ShipWarden MCP server.
 * Gemini CLI gets the file as its system defaults file, in place of the hook settings file.
 * Gemini CLI merges `mcpServers` of all settings files by the server name, so the user's own servers stay. A server of
 * the user with the name "shipwarden" has priority over this one.
 * `httpUrl` selects the Streamable HTTP transport.
 */
export function geminiMcpSettings(hookSettings: unknown, url: string, token: string): Record<string, unknown> {
    const settings: Record<string, unknown> =
        hookSettings && typeof hookSettings === 'object' && !Array.isArray(hookSettings) ? { ...(hookSettings as Record<string, unknown>) } : {};
    const servers = settings.mcpServers && typeof settings.mcpServers === 'object' && !Array.isArray(settings.mcpServers) ? settings.mcpServers : {};
    settings.mcpServers = { ...servers, [MCP_SERVER_NAME]: { httpUrl: url, headers: { Authorization: `Bearer ${token}` } } };
    return settings;
}

/**
 * Returns the `mcp` value of the inline opencode config. opencode replaces `{env:NAME}` with the value of the
 * environment variable, so the token comes from the environment of the session.
 */
export function opencodeMcpServers(url: string): Record<string, unknown> {
    return { [MCP_SERVER_NAME]: { type: 'remote', url, enabled: true, headers: { Authorization: `Bearer {env:${MCP_TOKEN_ENV}}` } } };
}

/**
 * A change that an MCP tool made to a pull request. The page patches its cached copies with it, so it does not load
 * the pull request again.
 */
export type AgentPullRequestChange =
    /** A new pull request. `status` is the new state of the worktree. */
    | { kind: 'created'; worktree: string; status: BranchStatus }
    /** One change of update_pull_request. `pr` is the pull request before the change. */
    | { kind: 'changed'; pr: PullRequest; change: PullRequestChange }
    /** A reply of reply_to_comment at the end of a review thread. `commentId` is the REST ID of the comment that got the reply. */
    | { kind: 'reply'; pr: PullRequest; threadId: string; commentId: number; body: string };
