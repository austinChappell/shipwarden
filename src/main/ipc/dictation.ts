import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import { isDictationEnded } from '@shared/dictation';
import type { Services } from '../services';

/** Returns true for a dictation ID from the page. The page makes a UUID. */
function isDictationId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 100;
}

/** Registers the IPC handlers of the dictation. The updates go to the window that started the dictation. */
export function registerDictationIpc({ dictation }: Pick<Services, 'dictation'>): void {
    ipcMain.on(IpcChannels.dictationStart, (event, id: unknown) => {
        if (!isDictationId(id)) return;
        const contents = event.sender;
        // A window that closes stops its dictation, so the microphone does not record without a page.
        const stopOnClose = () => dictation.cancel(id);
        contents.once('destroyed', stopOnClose);
        dictation.start(id, update => {
            if (isDictationEnded(update.state)) contents.off('destroyed', stopOnClose);
            if (!contents.isDestroyed()) contents.send(IpcChannels.dictationUpdate, update);
        });
    });
    ipcMain.on(IpcChannels.dictationStop, (_event, id: unknown) => {
        if (isDictationId(id)) dictation.stop(id);
    });
    ipcMain.on(IpcChannels.dictationCancel, (_event, id: unknown) => {
        if (isDictationId(id)) dictation.cancel(id);
    });
}
