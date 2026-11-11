import { ipcMain } from 'electron';
import * as os from 'os';
import * as path from 'path';
import { IpcChannels } from '@shared/api';
import { cleanProjectName, type PullRepoResult, type PullRepoTarget } from '@shared/projects';
import { checkRepoRef } from '@shared/review-checkout';
import type { Services } from '../services';
import { mainWorktreeRoot } from '../project-store';
import { cloneRepo } from '../repo-clone';
import { showOpenDialog } from './dialogs';

/** Returns a valid pull target. Throws an error when the value is not a valid target. */
function checkPullTarget(value: unknown): PullRepoTarget {
    const target = (value ?? {}) as Record<string, unknown>;
    if (typeof target.projectId === 'string' && target.projectId) {
        return { projectId: target.projectId };
    }
    if (typeof target.newProjectName === 'string') {
        return { newProjectName: cleanProjectName(target.newProjectName) };
    }
    throw new Error('Choose a project or type a name for a new project.');
}

/** Registers the IPC handlers of the projects and their repositories. */
export function registerProjectIpc({
    projects,
    projectWorktrees,
    reviewProviders,
    plans,
    window
}: Pick<Services, 'projects' | 'projectWorktrees' | 'reviewProviders' | 'plans' | 'window'>): void {
    ipcMain.handle(IpcChannels.projectsGet, () => projects.get());
    ipcMain.handle(IpcChannels.projectsCreate, (_event, name: string) => projects.create(String(name)));
    ipcMain.handle(IpcChannels.projectsRename, (_event, id: string, name: string) => projects.rename(id, String(name)));
    ipcMain.handle(IpcChannels.projectsDelete, async (_event, id: string) => {
        const state = await projects.delete(id);
        // The plans of the project have no place to show anymore.
        await plans.removeProject(id);
        return state;
    });
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
    ipcMain.handle(IpcChannels.projectsFindRepo, async (_event, repo: unknown) => (await projectWorktrees.localClone(checkRepoRef(repo))) ?? null);
    ipcMain.handle(IpcChannels.projectsPullRepo, async (_event, value: unknown, targetValue: unknown): Promise<PullRepoResult | null> => {
        const repo = checkRepoRef(value);
        const target = checkPullTarget(targetValue);
        const before = await projects.get();
        if ('projectId' in target && !before.projects.some(project => project.id === target.projectId)) {
            throw new Error('The project does not exist. It was possibly deleted.');
        }

        // A clone in another project is sufficient. ShipWarden clones only when no project has the repository.
        let root = await projectWorktrees.localClone(repo);
        if (!root) {
            // The dialog starts in the folder of the first project repository, for example ~/code.
            const firstRepo = before.projects.flatMap(project => project.repos)[0];
            const result = await showOpenDialog(window.get(), {
                title: `Clone ${repo.owner}/${repo.name}`,
                message: `Choose the folder for the clone. ShipWarden clones the repository into a new folder "${repo.name}" in it.`,
                buttonLabel: 'Clone Here',
                defaultPath: firstRepo ? path.dirname(firstRepo) : os.homedir(),
                properties: ['openDirectory', 'createDirectory']
            });
            if (result.canceled || result.filePaths.length === 0) {
                return null;
            }
            root = await cloneRepo(result.filePaths[0], repo, { repoFor: folder => reviewProviders.repoFor(folder) });
        }

        // The new project comes only after the clone. A failed clone must not leave an empty project.
        const projectId = 'projectId' in target ? target.projectId : (await projects.create(target.newProjectName)).activeId;
        await projects.addRepo(projectId, root);
        return { state: await projects.setActive(projectId), repo: (await mainWorktreeRoot(root)) ?? root };
    });
}
