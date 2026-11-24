import { promises as fs } from 'fs';
import { isAbsolute } from 'path';
import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import { DOCUMENT_EXTENSIONS, extensionOf, IMAGE_EXTENSIONS, isImageFileName } from '@shared/documents';
import type { Services } from '../services';
import { showOpenDialog } from './dialogs';

/** The largest image file that the chat reads (bytes). */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Returns true for an absolute file path from the page. */
function isFilePath(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 4096 && isAbsolute(value);
}

/** Registers the IPC handlers of the document attachments of the chat view. */
export function registerDocumentIpc({ documents, window }: Pick<Services, 'documents' | 'window'>): void {
    ipcMain.handle(IpcChannels.documentsChoose, async () => {
        const result = await showOpenDialog(window.get(), {
            title: 'Attach Files',
            buttonLabel: 'Attach',
            properties: ['openFile', 'multiSelections'],
            filters: [
                { name: 'Documents and Images', extensions: [...Object.keys(DOCUMENT_EXTENSIONS), ...IMAGE_EXTENSIONS] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        return result.canceled ? [] : result.filePaths;
    });
    ipcMain.handle(IpcChannels.documentsConvert, (_event, path: unknown) => {
        if (!isFilePath(path)) return { ok: false, error: 'The file path is not valid.' };
        return documents.convert(path);
    });
    ipcMain.handle(IpcChannels.documentsReadImage, async (_event, path: unknown) => {
        if (!isFilePath(path) || !isImageFileName(path)) throw new Error('The file is not an image.');
        const stat = await fs.stat(path);
        if (stat.size > MAX_IMAGE_BYTES) throw new Error('The image is too large. The maximum size is 20 MB.');
        const extension = extensionOf(path);
        const type = extension === 'jpg' ? 'jpeg' : extension;
        return `data:image/${type};base64,${(await fs.readFile(path)).toString('base64')}`;
    });
}
