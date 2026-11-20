import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import { parseStatsCi, parseStatsStart } from '@shared/stats';
import type { Services } from '../services';

/** Registers the IPC handlers of the agent stats. The page reads the log and adds the lines that only it can know. */
export function registerStatsIpc({ stats }: Pick<Services, 'stats'>): void {
    ipcMain.handle(IpcChannels.statsEvents, () => stats.events());
    ipcMain.handle(IpcChannels.statsStarted, (_event, start: unknown) => {
        const value = parseStatsStart(start);
        if (value) stats.started(value);
    });
    ipcMain.handle(IpcChannels.statsCi, (_event, change: unknown) => {
        const value = parseStatsCi(change);
        if (value) stats.ci(value);
    });
}
