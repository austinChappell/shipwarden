import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import type { Services } from '../services';

/** Registers the IPC handlers of the agent comparisons. */
export function registerCompareIpc({ compare }: Pick<Services, 'compare'>): void {
    ipcMain.handle(IpcChannels.compareList, () => compare.list());
    ipcMain.handle(IpcChannels.compareSave, (_event, group: unknown) => compare.save(group));
    ipcMain.handle(IpcChannels.compareRemove, (_event, id: unknown) => compare.remove(String(id)));
}
