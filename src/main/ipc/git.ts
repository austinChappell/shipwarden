import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import type { Services } from '../services';
import { fetchMaxAge, logLimit, optionalString, stringsOf } from './args';

/** Registers the IPC handlers of the local git changes. Each handler accepts only a worktree of a project. */
export function registerGitIpc({ gitChanges, projectWorktrees, worktrees }: Pick<Services, 'gitChanges' | 'projectWorktrees' | 'worktrees'>): void {
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
    ipcMain.handle(IpcChannels.gitBranchDiff, async (_event, worktree: string) => gitChanges.branchDiff(await known(worktree)));
    ipcMain.handle(IpcChannels.gitBranchContents, async (_event, worktree: string, path: string, base?: string, oldPath?: string) =>
        gitChanges.branchContents(await known(worktree), String(path), optionalString(base), optionalString(oldPath))
    );
    ipcMain.handle(IpcChannels.gitWorktreeFiles, async (_event, repo: string) => {
        const root = await known(repo);
        return gitChanges.worktreeFiles(root, await worktrees.list(root));
    });
    ipcMain.handle(IpcChannels.gitBlame, async (_event, worktree: string, path: string, contents?: unknown) =>
        gitChanges.blame(await known(worktree), String(path), optionalString(contents))
    );
    ipcMain.handle(IpcChannels.gitFileHistory, async (_event, worktree: string, path: string, limit: unknown) =>
        gitChanges.fileHistory(await known(worktree), String(path), logLimit(limit))
    );
    ipcMain.handle(IpcChannels.gitCommitFileContents, async (_event, worktree: string, commit: string, path: string, oldPath?: string) =>
        gitChanges.commitFileContents(await known(worktree), String(commit), String(path), optionalString(oldPath))
    );
    ipcMain.handle(IpcChannels.gitPull, async (_event, worktree: string) => gitChanges.pull(await known(worktree)));
    ipcMain.handle(IpcChannels.gitPush, async (_event, worktree: string) => gitChanges.push(await known(worktree)));
    ipcMain.handle(IpcChannels.gitDefaultBranch, async (_event, worktree: string) => gitChanges.defaultBranch(await known(worktree)));
    ipcMain.handle(IpcChannels.gitRebase, async (_event, worktree: string, onto?: unknown, oldBases?: unknown) =>
        gitChanges.rebase(await known(worktree), optionalString(onto), stringsOf(oldBases).slice(0, 10))
    );
    ipcMain.handle(IpcChannels.gitRebaseContinue, async (_event, worktree: string) => gitChanges.rebaseContinue(await known(worktree)));
    ipcMain.handle(IpcChannels.gitRebaseSkip, async (_event, worktree: string) => gitChanges.rebaseSkip(await known(worktree)));
    ipcMain.handle(IpcChannels.gitRebaseAbort, async (_event, worktree: string) => gitChanges.rebaseAbort(await known(worktree)));
    ipcMain.handle(IpcChannels.gitRebaseConflict, async (_event, worktree: string) => gitChanges.rebaseConflictInput(await known(worktree)));
    ipcMain.handle(IpcChannels.gitPushWithLease, async (_event, worktree: string) => gitChanges.pushWithLease(await known(worktree)));
}
