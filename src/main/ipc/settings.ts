import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import { networkErrorDetail } from '@shared/network';
import { commandProgram, type AppSettings, type CommandCheck } from '@shared/settings';
import { loginShellCaFile } from '../shell-env';
import { which } from '../lsp/servers';
import type { Services } from '../services';
import { changed } from './args';
import { showOpenDialog } from './dialogs';

/** The hosts that Settings › Network tests. */
export const NETWORK_TEST_HOSTS = [
    { name: 'GitHub', url: 'https://api.github.com/' },
    { name: 'ClickUp', url: 'https://api.clickup.com/' },
    { name: 'Azure DevOps', url: 'https://dev.azure.com/' }
];

type SettingsIpcDependencies = Pick<
    Services,
    'settings' | 'certificates' | 'tasks' | 'remote' | 'window' | 'shellReady' | 'networkReady' | 'updates' | 'usage'
>;

/** Registers the IPC handlers of the settings, the network certificates, the updates and the plan usage. */
export function registerSettingsIpc(deps: SettingsIpcDependencies): void {
    const { settings, certificates, tasks, remote, window, updates, usage } = deps;

    /** Finds the program of a command in the login shell PATH. A path with a slash must be an executable file. */
    async function checkCommand(command: string): Promise<CommandCheck> {
        await deps.shellReady;
        const program = commandProgram(command);
        if (!program) {
            return { program };
        }
        return { program, path: await which(program) };
    }

    ipcMain.handle(IpcChannels.settingsGet, () => settings.get());
    ipcMain.handle(IpcChannels.settingsUpdate, async (_event, change: Partial<AppSettings>) => {
        const before = await settings.get();
        const next = await settings.update(change);
        window.applyAppearance(next.appearance);
        if (changed(before.network, next.network)) {
            await certificates.apply(next.network, loginShellCaFile());
            // The plugins read NODE_EXTRA_CA_CERTS when they start. They start again at the next request.
            await tasks.stopAll();
        }
        if (changed(before.remote, next.remote)) {
            await remote.apply(next.remote);
        }
        return next;
    });
    ipcMain.handle(IpcChannels.settingsCheckCommand, (_event, command: string) => checkCommand(String(command)));

    ipcMain.handle(IpcChannels.networkStatus, async () => {
        await deps.networkReady;
        return { ...certificates.status(), shellFile: loginShellCaFile() };
    });
    ipcMain.handle(IpcChannels.networkTest, async () => {
        await deps.networkReady;
        return Promise.all(
            NETWORK_TEST_HOSTS.map(async host => {
                try {
                    // Any HTTP answer shows that the TLS connection works. The status code does not matter.
                    await fetch(host.url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
                    return { name: host.name, ok: true };
                } catch (error) {
                    return { name: host.name, ok: false, error: networkErrorDetail(error) };
                }
            })
        );
    });
    ipcMain.handle(IpcChannels.networkChooseCaFile, async () => {
        const result = await showOpenDialog(window.get(), {
            title: 'Choose a CA Certificates File',
            buttonLabel: 'Choose',
            properties: ['openFile', 'showHiddenFiles'],
            filters: [
                { name: 'Certificates', extensions: ['pem', 'crt', 'cer'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        return result.canceled ? undefined : result.filePaths[0];
    });

    ipcMain.handle(IpcChannels.updatesState, () => updates.getState());
    ipcMain.handle(IpcChannels.updatesCheck, () => updates.check());
    ipcMain.handle(IpcChannels.updatesInstall, () => updates.install());
    ipcMain.handle(IpcChannels.usageGet, () => usage.get());
    ipcMain.handle(IpcChannels.usageRefresh, () => usage.refresh(true));
}
