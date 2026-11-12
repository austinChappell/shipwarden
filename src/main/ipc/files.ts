import { ipcMain, shell } from 'electron';
import { IpcChannels } from '@shared/api';
import { isMediaKind } from '@shared/file-types';
import { detectKind, resolveInside } from '../files/file-service';
import type { Services } from '../services';

/** Registers the IPC handlers of the files in the worktrees. */
export function registerFileIpc({ files, fileWatcher, projectWorktrees }: Pick<Services, 'files' | 'fileWatcher' | 'projectWorktrees'>): void {
    ipcMain.handle(IpcChannels.filesListDirectory, (_event, root: string, directory: string) => files.listDirectory(root, directory));
    ipcMain.handle(IpcChannels.filesListFiles, (_event, root: string) => files.listFiles(root));
    ipcMain.handle(IpcChannels.filesSearch, (_event, root: string, query: string, caseSensitive?: boolean) =>
        files.searchContents(root, query, caseSensitive === true)
    );
    ipcMain.handle(IpcChannels.filesRead, (_event, root: string, file: string) => files.readFile(root, file));
    // Like files.read, info does not need a known worktree. The editor also opens files of other roots.
    ipcMain.handle(IpcChannels.filesInfo, (_event, root: string, file: string) => files.info(String(root), String(file)));
    ipcMain.handle(IpcChannels.filesReveal, async (_event, root: string, file: string) => {
        shell.showItemInFolder(resolveInside(await projectWorktrees.check(root), String(file)));
    });
    ipcMain.handle(IpcChannels.filesOpenInDefaultApp, async (_event, root: string, file: string) => {
        const absolute = resolveInside(await projectWorktrees.check(root), String(file));
        // Only viewable media files open. Thus the page cannot start a program or a script.
        if (!isMediaKind(await detectKind(absolute))) {
            throw new Error(`ShipWarden opens only images, PDF, audio and video files in the default app.`);
        }
        const message = await shell.openPath(absolute);
        if (message) {
            throw new Error(message);
        }
    });
    ipcMain.handle(IpcChannels.filesReadExternal, (_event, absolutePath: string) => files.readExternal(absolutePath));
    ipcMain.handle(IpcChannels.filesWrite, (_event, root: string, file: string, content: string) => files.writeFile(root, file, content));
    // The changes of files and folders work only in a known worktree.
    ipcMain.handle(IpcChannels.filesCreateFile, async (_event, root: string, file: string) =>
        files.createFile(await projectWorktrees.check(root), String(file))
    );
    ipcMain.handle(IpcChannels.filesCreateFolder, async (_event, root: string, folder: string) =>
        files.createFolder(await projectWorktrees.check(root), String(folder))
    );
    ipcMain.handle(IpcChannels.filesMove, async (_event, root: string, from: string, to: string) =>
        files.move(await projectWorktrees.check(root), String(from), String(to))
    );
    ipcMain.handle(IpcChannels.filesDelete, async (_event, root: string, paths: unknown) =>
        files.delete(await projectWorktrees.check(root), stringList(paths))
    );
    ipcMain.handle(IpcChannels.filesCopyIn, async (_event, root: string, sources: unknown, directory: string) =>
        files.copyIn(await projectWorktrees.check(root), stringList(sources), String(directory))
    );
    ipcMain.on(IpcChannels.filesWatch, (_event, root: string) => fileWatcher.start(root));
    ipcMain.on(IpcChannels.filesUnwatch, (_event, root: string) => fileWatcher.stop(root));
}

/** Converts an IPC argument to a list of strings. Throws an error for other values. */
function stringList(value: unknown): string[] {
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
        throw new Error('The paths must be a list of strings.');
    }
    return value;
}
