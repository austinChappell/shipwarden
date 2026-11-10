import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import type { ConnectionChange, TaskLink } from '@shared/tasks';
import type { Services } from '../services';

/** Registers the IPC handlers of the task managers and the task links of the worktrees. */
export function registerTaskIpc({ tasks }: Pick<Services, 'tasks'>): void {
    ipcMain.handle(IpcChannels.tasksPlugins, () => tasks.plugins());
    ipcMain.handle(IpcChannels.tasksConnections, () => tasks.connections());
    ipcMain.handle(IpcChannels.tasksAddConnection, (_event, pluginId: string, name: string) => tasks.addConnection(String(pluginId), String(name ?? '')));
    ipcMain.handle(IpcChannels.tasksUpdateConnection, (_event, id: string, change: ConnectionChange) => tasks.updateConnection(id, change));
    ipcMain.handle(IpcChannels.tasksSaveConnectionSettings, (_event, id: string, values: Record<string, string | boolean>) => tasks.saveConnectionSettings(id, values));
    ipcMain.handle(IpcChannels.tasksRemoveConnection, (_event, id: string) => tasks.removeConnection(id));
    ipcMain.handle(IpcChannels.tasksScopes, (_event, connectionId: string) => tasks.scopes(connectionId));
    ipcMain.handle(IpcChannels.tasksEnabledConnections, () => tasks.enabledConnections());
    ipcMain.handle(IpcChannels.tasksSource, (_event, connectionId: string, projectId: string) => tasks.source(connectionId, projectId));
    ipcMain.handle(IpcChannels.tasksRequest, (_event, connectionId: string, projectId: string, method: string, params: unknown) =>
        tasks.request(connectionId, projectId, method, params));
    ipcMain.handle(IpcChannels.tasksLinks, () => tasks.allLinks());
    ipcMain.handle(IpcChannels.tasksSelectedCollection, (_event, connectionId: string) => tasks.selectedCollection(connectionId));
    ipcMain.handle(IpcChannels.tasksSetSelectedCollection, (_event, connectionId: string, collectionId: string) =>
        tasks.setSelectedCollection(connectionId, String(collectionId)));
    ipcMain.handle(IpcChannels.tasksSelectedConnection, (_event, projectId: string) => tasks.selectedConnection(projectId));
    ipcMain.handle(IpcChannels.tasksSetSelectedConnection, (_event, projectId: string, connectionId: string) =>
        tasks.setSelectedConnection(projectId, String(connectionId)));
    ipcMain.handle(IpcChannels.tasksSetLink, (_event, worktreePath: string, link: TaskLink | null) => tasks.setLink(worktreePath, link));
}
