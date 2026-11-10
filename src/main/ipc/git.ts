import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import type { Services } from '../services';
import { fetchMaxAge, logLimit, optionalString, stringsOf } from './args';

/** Registers the IPC handlers of the local git changes. Each handler accepts only a worktree of a project. */
export function registerGitIpc({ gitChanges, projectWorktrees }: Pick<Services, 'gitChanges' | 'projectWorktrees'>): void {
    const known = (worktree: unknown) => projectWorktrees.check(worktree);
    ipcMain.handle(IpcChannels.gitChanges, async (_event, worktree: string) => gitChanges.status(await known(worktree)));
    ipcMain.handle(IpcChannels.gitStage, async (_event, worktree: string, paths: unknown) => gitChanges.stage(await known(worktree), stringsOf(paths)));
    ipcMain.handle(IpcChannels.gitUnstage, async (_event, worktree: string, paths: unknown) => gitChanges.unstage(await known(worktree), stringsOf(paths)));
    ipcMain.handle(IpcChannels.gitContents, async (_event, worktree: string, path: string, side: string, oldPath?: string) =>
        gitChanges.contents(await known(worktree), String(path), side === 'staged' ? 'staged' : 'unstaged', optionalString(oldPath))
    );
    ipcMain.handle(IpcChannels.gitCommit, async (_event, worktree: string, message: string, amend: boolean) =>
        gitChanges.commit(await known(worktree), String(message), amend === true)
    );
    ipcMain.handle(IpcChannels.gitLastMessage, async (_event, worktree: string) => gitChanges.lastMessage(await known(worktree)));
    ipcMain.handle(IpcChannels.gitDiscard, async (_event, worktree: string, paths: unknown) => gitChanges.discard(await known(worktree), stringsOf(paths)));
    ipcMain.handle(IpcChannels.gitFetch, async (_event, worktree: string, force?: boolean) => gitChanges.fetch(await known(worktree), fetchMaxAge(force)));
    ipcMain.handle(IpcChannels.gitLog, async (_event, worktree: string, scope: unknown, limit: unknown) =>
        gitChanges.log(await known(worktree), scope === 'local' ? 'local' : 'all', logLimit(limit))
    );
    ipcMain.handle(IpcChannels.gitPull, async (_event, worktree: string) => gitChanges.pull(await known(worktree)));
    ipcMain.handle(IpcChannels.gitPush, async (_event, worktree: string) => gitChanges.push(await known(worktree)));
}
