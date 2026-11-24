import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import type { Services } from '../services';

/** Registers the IPC handlers of the MCP server: the approvals of the write tools (Settings › Agents) and the watches of watch_pull_request. */
export function registerMcpIpc({ mcp }: Pick<Services, 'mcp'>): void {
    ipcMain.handle(IpcChannels.mcpApprovals, () => mcp.approvals.list());
    ipcMain.handle(IpcChannels.mcpRevoke, (_event, worktree: unknown) => mcp.approvals.revoke(String(worktree)));
    ipcMain.handle(IpcChannels.mcpWatches, () => mcp.watches.list());
    ipcMain.handle(IpcChannels.mcpUnwatch, async (_event, id: unknown) => {
        await mcp.watches.remove(watch => watch.id === String(id));
    });
}
