import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import type { BrowserBounds, BrowserFindOptions } from '@shared/browser';
import type { Services } from '../services';
import { validBounds } from './args';

/** Registers the IPC handlers of the in-app browser. */
export function registerBrowserIpc({ browserViews, window }: Pick<Services, 'browserViews' | 'window'>): void {
    // The view shows in the window of the page that made it.
    ipcMain.on(IpcChannels.browserCreate, (event, id: string, url: string) => {
        const owner = window.fromContents(event.sender);
        if (owner) browserViews.create(String(id), String(url), owner);
    });
    ipcMain.on(IpcChannels.browserSetBounds, (_event, id: string, bounds: BrowserBounds | null) => browserViews.setBounds(String(id), validBounds(bounds)));
    ipcMain.on(IpcChannels.browserLoad, (_event, id: string, url: string) => browserViews.load(String(id), String(url)));
    ipcMain.on(IpcChannels.browserBack, (_event, id: string) => browserViews.back(String(id)));
    ipcMain.on(IpcChannels.browserForward, (_event, id: string) => browserViews.forward(String(id)));
    ipcMain.on(IpcChannels.browserReload, (_event, id: string) => browserViews.reload(String(id)));
    ipcMain.on(IpcChannels.browserStop, (_event, id: string) => browserViews.stop(String(id)));
    ipcMain.on(IpcChannels.browserFocus, (_event, id: string) => browserViews.focus(String(id)));
    ipcMain.on(IpcChannels.browserDestroy, (_event, id: string) => browserViews.destroy(String(id)));
    ipcMain.on(IpcChannels.browserFind, (_event, id: string, text: string, options: BrowserFindOptions) =>
        browserViews.find(String(id), String(text), {
            next: options?.next === true,
            forward: options?.forward !== false,
            matchCase: options?.matchCase === true
        })
    );
    ipcMain.on(IpcChannels.browserStopFind, (_event, id: string) => browserViews.stopFind(String(id)));
    ipcMain.handle(IpcChannels.browserState, (_event, id: string) => browserViews.state(String(id)));
}
