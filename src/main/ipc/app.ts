import { app, ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import type { AppKeyAction } from '@shared/shortcuts';
import { isAppKeyAction } from '../app/keys';
import type { Services } from '../services';

type AppIpcDependencies = Pick<Services, 'window' | 'confirm' | 'ptyHostLog'> & {
    /** Runs an app key of the macOS menu. */
    runAppKey(action: AppKeyAction): void;
};

/** Registers the IPC handlers of the app: the app info, the window focus, the app keys and the confirm answers. */
export function registerAppIpc({ window, confirm, ptyHostLog, runAppKey }: AppIpcDependencies): void {
    ipcMain.handle(IpcChannels.appInfo, () => ({ version: app.getVersion(), dataFolder: app.getPath('userData'), ptyHostLog }));
    ipcMain.on(IpcChannels.appFocus, () => {
        const current = window.get();
        if (current) {
            if (current.isMinimized()) current.restore();
            current.show();
            app.focus({ steal: true });
        }
    });
    ipcMain.on(IpcChannels.appRunKey, (_event, action: unknown) => {
        if (isAppKeyAction(action)) runAppKey(action);
    });
    ipcMain.on(IpcChannels.appConfirmAnswer, (_event, id: number, confirmed: boolean) => confirm.answer(Number(id), confirmed === true));
}
