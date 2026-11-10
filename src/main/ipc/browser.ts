import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import type { BrowserBounds } from '@shared/browser';
import type { Services } from '../services';
import { validBounds } from './args';

/** Registers the IPC handlers of the in-app browser. */
export function registerBrowserIpc({ browserViews }: Pick<Services, 'browserViews'>): void {
    ipcMain.on(IpcChannels.browserCreate, (_event, id: string, url: string) => browserViews.create(String(id), String(url)));
    ipcMain.on(IpcChannels.browserSetBounds, (_event, id: string, bounds: BrowserBounds | null) => browserViews.setBounds(String(id), validBounds(bounds)));
    ipcMain.on(IpcChannels.browserLoad, (_event, id: string, url: string) => browserViews.load(String(id), String(url)));
    ipcMain.on(IpcChannels.browserBack, (_event, id: string) => browserViews.back(String(id)));
    ipcMain.on(IpcChannels.browserForward, (_event, id: string) => browserViews.forward(String(id)));
    ipcMain.on(IpcChannels.browserReload, (_event, id: string) => browserViews.reload(String(id)));
    ipcMain.on(IpcChannels.browserStop, (_event, id: string) => browserViews.stop(String(id)));
    ipcMain.on(IpcChannels.browserFocus, (_event, id: string) => browserViews.focus(String(id)));
    ipcMain.on(IpcChannels.browserDestroy, (_event, id: string) => browserViews.destroy(String(id)));
    ipcMain.handle(IpcChannels.browserState, (_event, id: string) => browserViews.state(String(id)));
}
