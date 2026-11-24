import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import type { SlackTokenInput } from '@shared/slack';
import type { Services } from '../services';

function tokenText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Registers the IPC handlers of Settings › Slack. The tokens go to the keychain. The page never gets them back. */
export function registerSlackIpc({ slack, slackTokens }: Pick<Services, 'slack' | 'slackTokens'>): void {
    ipcMain.handle(IpcChannels.slackStatus, async () => {
        // The first call reads the saved tokens, so the page shows them also while the connection is off.
        await slack.apply();
        return slack.status();
    });
    ipcMain.handle(IpcChannels.slackSaveTokens, async (_event, input: SlackTokenInput | undefined) => {
        await slackTokens.save({ bot: tokenText(input?.bot), app: tokenText(input?.app) });
        await slack.apply();
        return slack.status();
    });
    ipcMain.handle(IpcChannels.slackClearTokens, async () => {
        await slackTokens.clear();
        await slack.apply();
        return slack.status();
    });
    ipcMain.handle(IpcChannels.slackChannels, () => slack.channels());
}
