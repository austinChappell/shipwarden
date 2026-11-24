import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import type { CliPageResult } from '@shared/cli';
import type { Services } from '../services';

/** Registers the IPC handlers of the `shipwarden` CLI: the link of Settings › Agents, and the answers of the page. */
export function registerCliIpc({ cliInstaller, cliPage }: Pick<Services, 'cliInstaller' | 'cliPage'>): void {
    ipcMain.handle(IpcChannels.cliInstallState, () => cliInstaller.state());
    ipcMain.handle(IpcChannels.cliInstall, () => cliInstaller.install());
    ipcMain.handle(IpcChannels.cliRemove, () => cliInstaller.remove());
    ipcMain.on(IpcChannels.cliPageAnswer, (_event, id: unknown, result: unknown, error: unknown) => {
        const answer = result && typeof result === 'object' ? (result as CliPageResult) : undefined;
        cliPage.answer(Number(id), answer, typeof error === 'string' ? error : undefined);
    });
}
