import { existsSync } from 'fs';
import * as path from 'path';
import { ipcMain, shell } from 'electron';
import { IpcChannels } from '@shared/api';
import { isKeyCommandId } from '@shared/shortcuts';
import type { KeybindingChange } from '@shared/keybindings';
import type { Services } from '../services';

/** The IDs of the web contents that record a key in Settings › Keyboard. */
const recordingContents = new Set<number>();

/** Returns true while the page of the web contents records a key. The main process then does not run the shortcuts. */
export function isRecordingKeys(webContentsId: number): boolean {
    return recordingContents.has(webContentsId);
}

/** Returns the changes that the page sent, or throws. The page can send any value, so the main process checks it. */
function readChanges(value: unknown): KeybindingChange[] {
    if (!Array.isArray(value)) throw new Error('The changes must be a list.');
    return value.map(item => {
        const change = item as { command?: unknown; keys?: unknown; reset?: unknown } | null;
        if (!change || !isKeyCommandId(change.command)) throw new Error('A change has no valid command.');
        if (change.reset === true) return { command: change.command, reset: true };
        if (!Array.isArray(change.keys) || !change.keys.every(key => typeof key === 'string')) throw new Error('A change has no valid keys.');
        return { command: change.command, keys: change.keys as string[] };
    });
}

/** Registers the IPC handlers of the keybindings file. */
export function registerKeybindingIpc({ keybindings }: Pick<Services, 'keybindings'>): void {
    ipcMain.handle(IpcChannels.keybindingsGet, () => keybindings.state());
    ipcMain.handle(IpcChannels.keybindingsUpdate, (_event, changes: unknown) => keybindings.update(readChanges(changes)));
    ipcMain.handle(IpcChannels.keybindingsResetAll, () => keybindings.resetAll());
    ipcMain.on(IpcChannels.keybindingsRecord, (event, on: unknown) => {
        const contents = event.sender;
        if (on === true) {
            if (!recordingContents.has(contents.id)) contents.once('destroyed', () => recordingContents.delete(contents.id));
            recordingContents.add(contents.id);
        } else recordingContents.delete(contents.id);
    });
    ipcMain.on(IpcChannels.keybindingsReveal, () => {
        if (existsSync(keybindings.file)) shell.showItemInFolder(keybindings.file);
        else void shell.openPath(path.dirname(keybindings.file));
    });
}
