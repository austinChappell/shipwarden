import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import type { Services } from '../services';
import { showOpenDialog } from './dialogs';

/** Registers the IPC handlers of the projects and their repositories. */
export function registerProjectIpc({ projects, window }: Pick<Services, 'projects' | 'window'>): void {
    ipcMain.handle(IpcChannels.projectsGet, () => projects.get());
    ipcMain.handle(IpcChannels.projectsCreate, (_event, name: string) => projects.create(String(name)));
    ipcMain.handle(IpcChannels.projectsRename, (_event, id: string, name: string) => projects.rename(id, String(name)));
    ipcMain.handle(IpcChannels.projectsDelete, (_event, id: string) => projects.delete(id));
    ipcMain.handle(IpcChannels.projectsSetActive, (_event, id: string) => projects.setActive(id));
    ipcMain.handle(IpcChannels.projectsRemoveRepo, (_event, id: string, repo: string) => projects.removeRepo(id, repo));
    ipcMain.handle(IpcChannels.projectsMove, (_event, id: string, toIndex: number) => projects.move(id, Number(toIndex)));
    ipcMain.handle(IpcChannels.projectsMoveRepo, (_event, id: string, repo: string, toIndex: number) => projects.moveRepo(id, repo, Number(toIndex)));
    ipcMain.handle(IpcChannels.projectsChooseRepo, async (_event, id: string) => {
        const result = await showOpenDialog(window.get(), { title: 'Add Repository', buttonLabel: 'Add', properties: ['openDirectory'] });
        if (result.canceled || result.filePaths.length === 0) {
            return projects.get();
        }
        return projects.addRepo(id, result.filePaths[0]);
    });
}
