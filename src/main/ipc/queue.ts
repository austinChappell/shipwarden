import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import type { Services } from '../services';

/** Registers the IPC handlers of the task queue. */
export function registerQueueIpc({ queue }: Pick<Services, 'queue'>): void {
    ipcMain.handle(IpcChannels.queueGet, () => queue.get());
    ipcMain.handle(IpcChannels.queueSave, (_event, state: unknown) => queue.save(state));
}
