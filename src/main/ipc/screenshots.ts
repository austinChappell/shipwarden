import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import type { ScreenshotSide } from '@shared/screenshots';
import type { Services } from '../services';

function sideOf(value: unknown): ScreenshotSide {
    if (value !== 'branch' && value !== 'base') throw new Error(`"${String(value)}" is not a screenshot side.`);
    return value;
}

/** Registers the IPC handlers of the screenshots of visual changes. Each handler accepts only a worktree of a project. */
export function registerScreenshotsIpc({ screenshots }: Pick<Services, 'screenshots'>): void {
    ipcMain.handle(IpcChannels.screenshotsGet, (_event, worktree: string) => screenshots.state(worktree));
    ipcMain.handle(IpcChannels.screenshotsCapture, (_event, worktree: string, side: unknown) => screenshots.capture(worktree, sideOf(side)));
    ipcMain.handle(IpcChannels.screenshotsImage, (_event, worktree: string, side: unknown, page: unknown) =>
        screenshots.image(worktree, sideOf(side), String(page))
    );
    ipcMain.handle(IpcChannels.screenshotsClear, (_event, worktree: string) => screenshots.clear(worktree));
    ipcMain.handle(IpcChannels.screenshotsPost, (_event, worktree: string, number: unknown) => {
        const value = Number(number);
        if (!Number.isInteger(value) || value <= 0) throw new Error('The pull request number is not valid.');
        return screenshots.post(worktree, value);
    });
}
