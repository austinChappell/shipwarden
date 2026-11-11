import { basename } from 'path';
import * as os from 'os';
import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import type { CreatedWorktree, CreateWorktreeOptions, RemoveWorktreeResult } from '@shared/worktrees';
import { normalizeWorktreeSettings, resolveWorktreeSettings, scriptEnvironment } from '@shared/worktree-settings';
import { worktreesRoot } from '../worktrees/git-worktree-service';
import { runScript } from '../worktrees/run-script';
import type { Services } from '../services';
import { showOpenDialog } from './dialogs';

type WorktreeIpcDependencies = Pick<Services, 'worktrees' | 'settings' | 'reviewCheckouts' | 'processes' | 'terminals' | 'lsp' | 'window'>;

/** Registers the IPC handlers of the worktrees and their branches. */
export function registerWorktreeIpc({ worktrees, settings, reviewCheckouts, processes, terminals, lsp, window }: WorktreeIpcDependencies): void {
    /** The worktree settings of a repository: its own settings, else the global settings. */
    async function worktreeSettingsFor(repoPath: string) {
        const all = await settings.get();
        return resolveWorktreeSettings(all.worktrees, all.repos[repoPath]?.worktrees, repoPath, worktreesRoot(), os.homedir());
    }

    // The copies of pull requests for the Review view are worktrees too, but the sidebar does not show them.
    ipcMain.handle(IpcChannels.worktreesList, async (_event, repoPath: string) =>
        worktrees.withDates((await worktrees.list(repoPath)).filter(item => !reviewCheckouts.isInFolder(item.path)))
    );
    ipcMain.handle(IpcChannels.worktreesBranches, (_event, repoPath: string) => worktrees.branches(String(repoPath)));
    ipcMain.handle(IpcChannels.worktreesCreate, async (_event, options: CreateWorktreeOptions): Promise<CreatedWorktree> => {
        const config = await worktreeSettingsFor(options.repoPath);
        const worktree = await worktrees.create(options, config.parentFolder);
        if (!config.copyIgnored.enabled) {
            return { ...worktree, copied: [] };
        }
        try {
            return { ...worktree, copied: await worktrees.copyIgnored(options.repoPath, worktree.path, config.copyIgnored) };
        } catch (error) {
            return { ...worktree, copied: [], copyError: error instanceof Error ? error.message : String(error) };
        }
    });
    ipcMain.handle(
        IpcChannels.worktreesRemove,
        async (_event, repoPath: string, worktreePath: string, options?: { skipTeardown?: boolean }): Promise<RemoveWorktreeResult> => {
            const config = await worktreeSettingsFor(repoPath);
            // Git does not remove a worktree with changes. Check first, so the teardown and the process stop do not occur for nothing.
            if (await worktrees.uncommittedChanges(worktreePath)) {
                throw new Error('The worktree has uncommitted changes. Commit or remove them first.');
            }
            if (config.teardownScript && !options?.skipTeardown) {
                const main = (await worktrees.list(repoPath)).find(item => item.isMain);
                const worktree = (await worktrees.list(repoPath)).find(item => item.path === worktreePath);
                const env = scriptEnvironment({
                    rootPath: main?.path ?? repoPath,
                    worktreePath,
                    branch: worktree?.branch,
                    repoName: basename(main?.path ?? repoPath)
                });
                const result = await runScript(config.teardownScript, worktreePath, env);
                if (result.code !== 0) {
                    return { removed: false, teardownFailed: result };
                }
            }
            // Stop the processes before the folder goes away: the terminals, the processes that they started, and the other processes in the folder.
            const pids = await processes.worktreePids(worktreePath).catch(() => []);
            await terminals.killWorktree(worktreePath);
            await lsp.stopRoot(worktreePath);
            await processes.terminate(pids).catch(error => console.error('[processes] Cannot stop the processes of a worktree:', error));
            await worktrees.remove(repoPath, worktreePath);
            return { removed: true };
        }
    );
    ipcMain.handle(IpcChannels.worktreesPreviewCopy, (_event, repoPath: string, copy: unknown) =>
        worktrees.ignoredMatches(String(repoPath), normalizeWorktreeSettings({ copyIgnored: copy }).copyIgnored)
    );
    ipcMain.handle(IpcChannels.worktreesDefaultFolder, () => worktreesRoot());
    ipcMain.handle(IpcChannels.worktreesDeleteBranch, (_event, repoPath: string, branch: string, force?: boolean, mergedHead?: string) =>
        worktrees.deleteBranch(String(repoPath), String(branch), force === true, typeof mergedHead === 'string' && mergedHead ? mergedHead : undefined)
    );
    ipcMain.handle(IpcChannels.worktreesChooseFolder, async () => {
        const result = await showOpenDialog(window.get(), {
            title: 'Choose a Folder for Worktrees',
            buttonLabel: 'Choose',
            properties: ['openDirectory', 'createDirectory']
        });
        return result.canceled ? undefined : result.filePaths[0];
    });
}
