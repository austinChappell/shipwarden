/**
 * The ShipWarden MCP server: the tools that agents can call, and the approvals of the write tools.
 * The functions of this module use no Electron API. The main process and the page both use them.
 */

/** The name of the server in the MCP config of an agent. The tools show as `mcp__shipwarden__<tool>` in Claude Code. */
export const MCP_SERVER_NAME = 'shipwarden';

/** The path of the MCP endpoint on the local server. */
export const MCP_PATH = '/mcp';

/** The tools that read data. They need no approval. */
export const MCP_READ_TOOLS = ['list_worktrees', 'get_overlaps', 'get_task'] as const;

/** The tools that change something or start an agent. Each one needs approval the first time in a worktree. */
export const MCP_WRITE_TOOLS = ['ask_agent', 'set_task_status'] as const;

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

/** The label of a write tool for the approval dialog and Settings › Agents. */
export function writeToolLabel(tool: McpWriteTool): string {
    return tool === 'ask_agent' ? 'Ask the agent of another worktree' : 'Change the status of the task';
}

/**
 * Returns the MCP config that Claude Code gets with --mcp-config. The server uses the Streamable HTTP transport.
 * The token in the header identifies the session and its worktree.
 */
export function mcpConfig(url: string, token: string): { mcpServers: Record<string, { type: 'http'; url: string; headers: Record<string, string> }> } {
    return { mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } };
}
