import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import type { Services } from '../services';

/** Registers the IPC handlers of the MCP server: the approvals of the write tools (Settings › Agents). */
export function registerMcpIpc({ mcp }: Pick<Services, 'mcp'>): void {
    ipcMain.handle(IpcChannels.mcpApprovals, () => mcp.approvals.list());
    ipcMain.handle(IpcChannels.mcpRevoke, (_event, worktree: unknown) => mcp.approvals.revoke(String(worktree)));
}
