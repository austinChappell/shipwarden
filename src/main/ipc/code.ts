import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import { checkCommitSha, checkPullNumber, checkRepoRef } from '@shared/review-checkout';
import type { Services } from '../services';

/** Registers the IPC handlers of the language servers and the local copies of pull requests. */
export function registerCodeIpc({ lsp, reviewCheckouts, shellReady }: Pick<Services, 'lsp' | 'reviewCheckouts' | 'shellReady'>): void {
    ipcMain.handle(IpcChannels.reviewCheckoutStatus, (_event, repo: unknown, number: unknown) =>
        reviewCheckouts.status(checkRepoRef(repo), checkPullNumber(number)));
    ipcMain.handle(IpcChannels.reviewCheckout, async (_event, repo: unknown, number: unknown, sha: unknown, allowClone: unknown) => {
        await shellReady;
        return reviewCheckouts.ensure(checkRepoRef(repo), checkPullNumber(number), checkCommitSha(sha), allowClone === true);
    });
    ipcMain.handle(IpcChannels.reviewRelease, async (_event, root: unknown) => {
        // The language servers of a copy stop when the Review view closes the pull request.
        const value = String(root);
        if (await reviewCheckouts.has(value)) await lsp.stopRoot(value);
    });

    ipcMain.handle(IpcChannels.lspEnsure, (_event, root: string, languageId: string) => lsp.ensure(root, languageId));
    ipcMain.handle(IpcChannels.lspMissing, (_event, root: string, languageId: string) => lsp.missing(root, languageId));
    ipcMain.handle(IpcChannels.lspRequest, (_event, key: string, method: string, params: unknown) => lsp.request(key, method, params));
    ipcMain.on(IpcChannels.lspNotify, (_event, key: string, method: string, params: unknown) => lsp.notify(key, method, params));
}
