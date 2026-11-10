import { ipcMain, shell } from 'electron';
import { IpcChannels, type NotificationRequest } from '@shared/api';
import type { Services } from '../services';

/** Registers the IPC handlers of the notes and the notifications, and starts to watch the notes folder. */
export function registerNotesIpc({ notes, notifications, window }: Pick<Services, 'notes' | 'notifications' | 'window'>): void {
    ipcMain.on(IpcChannels.notificationsShow, (_event, request: NotificationRequest) => {
        if (request && typeof request === 'object' && typeof request.title === 'string') notifications.show(request);
    });
    ipcMain.on(IpcChannels.notificationsPlaySound, (_event, name: string) => notifications.playSound(String(name)));
    ipcMain.handle(IpcChannels.notesFolder, () => notes.folder);
    ipcMain.handle(IpcChannels.notesList, () => notes.list());
    ipcMain.handle(IpcChannels.notesFolders, () => notes.folders());
    ipcMain.handle(IpcChannels.notesCreateFolder, (_event, name: string) => notes.createFolder(String(name)));
    ipcMain.handle(IpcChannels.notesRenameFolder, (_event, name: string, newName: string) => notes.renameFolder(String(name), String(newName)));
    ipcMain.handle(IpcChannels.notesDeleteFolder, (_event, name: string) => notes.deleteFolder(String(name)));
    ipcMain.handle(IpcChannels.notesRead, (_event, name: string) => notes.read(String(name)));
    ipcMain.handle(IpcChannels.notesWrite, (_event, name: string, content: string) => notes.write(String(name), String(content)));
    ipcMain.handle(IpcChannels.notesCreate, (_event, name: string, content?: string) => notes.create(String(name), typeof content === 'string' ? content : ''));
    ipcMain.handle(IpcChannels.notesRename, (_event, name: string, newName: string) => notes.rename(String(name), String(newName)));
    ipcMain.handle(IpcChannels.notesDelete, (_event, name: string) => notes.delete(String(name)));
    ipcMain.handle(IpcChannels.notesSetTags, (_event, name: string, tags: unknown) => notes.setTags(String(name), Array.isArray(tags) ? tags : []));
    ipcMain.on(IpcChannels.notesReveal, (_event, name?: string) => {
        if (typeof name === 'string' && name) {
            shell.showItemInFolder(notes.pathOf(name));
        } else {
            void shell.openPath(notes.folder);
        }
    });
    void notes
        .watch(() => window.send(IpcChannels.notesChanged))
        .catch(error => console.warn(`[notes] The notes folder is not watched: ${error instanceof Error ? error.message : String(error)}`));
}
