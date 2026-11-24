import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import type { Services } from '../services';

/** Registers the IPC handlers of the server for the phone app (Settings › Mobile). */
export function registerRemoteIpc({ remote, push }: Pick<Services, 'remote' | 'push'>): void {
    ipcMain.handle(IpcChannels.remoteStatus, () => remote.status());
    ipcMain.handle(IpcChannels.remoteStartPairing, () => remote.startPairing());
    ipcMain.handle(IpcChannels.remoteCancelPairing, () => remote.cancelPairing());
    ipcMain.handle(IpcChannels.remoteRemoveDevice, (_event, id: string) => remote.removeDevice(String(id)));
    ipcMain.handle(IpcChannels.remoteSetDevicePermissions, (_event, id: string, permissions: { canStartAgents?: unknown } | undefined) =>
        remote.setDevicePermissions(String(id), { canStartAgents: permissions?.canStartAgents === true })
    );
    ipcMain.handle(IpcChannels.remoteTestPush, () => push.test());
}
