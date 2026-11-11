import { join } from 'path';
import { mkdirSync } from 'fs';
import { app, BrowserWindow, Menu, protocol, shell } from 'electron';
import * as os from 'os';
import { IpcChannels } from '@shared/api';
import { AZURE_IMAGE_SCHEME } from '@shared/azure-image-url';
import { FILE_SCHEME } from '@shared/file-url';
import type { HelpAction } from '@shared/onboarding';
import { appKeyAction, shortcutAction, type AppKeyAction, type ShortcutAction } from '@shared/shortcuts';
import { removeAgentSessionVariables } from './agent-environment';
import { writeAgentHookFiles } from './agents/hook-files';
import { browserViewKey } from './app/keys';
import { MainWindow } from './app/main-window';
import { menuTemplate } from './app/menu';
import { userDataOverride } from './app/user-data';
import { createAzureImageHandler } from './azure/azure-image-protocol';
import { quitAndStopSessions } from './app/quit';
import { createFileProtocolHandler } from './files/file-protocol';
import { registerIpc } from './ipc';
import { migrateLegacyData } from './legacy-migration';
import { ensureOnboarding } from './onboarding';
import { createServices } from './services';

// Do this first. Terminals must not inherit the session of an agent that started ShipWarden.
removeAgentSessionVariables(process.env);

// For a test of a first start: SHIPWARDEN_USER_DATA_DIR=/tmp/sw-fresh uses that folder for the app data. Set it before
// the app reads any data.
const separateDataFolder = userDataOverride(process.env, process.cwd(), os.homedir());
if (separateDataFolder) {
    mkdirSync(separateDataFolder, { recursive: true });
    app.setPath('userData', separateDataFolder);
    console.log(`[data] The app data folder is ${separateDataFolder}.`);
}

// The app was Yardmaster before. Copy its data one time, before the stores below read their files.
// A separate data folder gets no copy, so a test of a first start does not get the old data.
const migration = separateDataFolder
    ? { copied: [], errors: [] }
    : migrateLegacyData({ appData: app.getPath('appData'), userData: app.getPath('userData'), home: os.homedir() });
migration.copied.forEach(item => console.log(`[migration] Copied ${item}`));
migration.errors.forEach(item => console.error(`[migration] ${item}`));

// For automated UI checks: SHIPWARDEN_DEBUG_PORT=9333 opens the Chrome DevTools Protocol on that port.
if (process.env.SHIPWARDEN_DEBUG_PORT) {
    app.commandLine.appendSwitch('remote-debugging-port', process.env.SHIPWARDEN_DEBUG_PORT);
}

// The viewers of images, PDF, audio and video files get the files through this protocol.
// The scheme must be privileged before the app is ready. "stream" lets <video> and <audio> read byte ranges.
// The Markdown of Azure DevOps gets its images through the second protocol, because these images require a token.
protocol.registerSchemesAsPrivileged([
    { scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    { scheme: AZURE_IMAGE_SCHEME, privileges: { standard: true, secure: true } }
]);

const mainWindow = new MainWindow();
const services = createServices({
    window: mainWindow,
    mainFolder: __dirname,
    onBrowserInput: (id, input) => browserKey(id, input),
    separateDataFolder: !!separateDataFolder
});
const { terminals, browserViews, settings } = services;

function createWindow(): void {
    mainWindow.create({
        preload: join(__dirname, '../preload/index.js'),
        devServerUrl: process.env.ELECTRON_RENDERER_URL,
        page: join(__dirname, '../renderer/index.html'),
        onClosed: () => browserViews.destroyAll(),
        // The workspace keys go to the app before the page gets them. A focused terminal takes all keys, so the menu
        // shortcuts alone do not work in a terminal. preventDefault also stops the menu item, so the action happens once.
        onInput: (event, input) => {
            const action = shortcutAction(input);
            if (action) {
                event.preventDefault();
                sendShortcut(action);
                return;
            }
            // A focused terminal takes all keys, so the menu does not get ⌘Q, ⌘, or ⌘H. Run them here.
            const appAction = appKeyAction(input);
            if (appAction) {
                event.preventDefault();
                runAppKey(appAction);
            }
        }
    });
}

/** Shows the window and opens the settings page. A section, for example "about", opens that section. */
function openSettings(section?: string): void {
    if (!mainWindow.get()) {
        createWindow();
    }
    mainWindow.get()?.show();
    mainWindow.send(IpcChannels.appOpenSettings, section);
}

/**
 * Checks for updates and does not change the page. The page shows the result in a notice that closes after a few
 * seconds. A failed check also goes to the page as a state with the "error" status.
 */
function checkForUpdates(): void {
    if (!mainWindow.get()) {
        createWindow();
    }
    mainWindow.get()?.show();
    void services.updates.check().then(
        state => mainWindow.send(IpcChannels.updatesChecked, state),
        () => undefined
    );
}

/** Shows the window and sends an item of the Help menu to the page. */
function sendHelp(action: HelpAction): void {
    if (!mainWindow.get()) {
        createWindow();
    }
    mainWindow.get()?.show();
    mainWindow.send(IpcChannels.appHelp, action);
}

function sendShortcut(action: ShortcutAction): void {
    mainWindow.send(IpcChannels.appShortcut, action);
}

/** Stops all terminal sessions and the PTY host after the user confirms, then quits. */
function quitAndStop(): Promise<void> {
    return quitAndStopSessions({
        sessions: async () => (terminals.isConnected() ? terminals.list().catch(() => []) : []),
        confirm: request => services.confirm.ask(request),
        shutdownHost: () => terminals.shutdownHost(),
        quit: () => app.quit()
    });
}

/** Runs an app key of the macOS menu: ⌘Q, ⇧⌥⌘Q, ⌘, ⇧⌘U or ⌘H. */
function runAppKey(action: AppKeyAction): void {
    if (action === 'quit') app.quit();
    else if (action === 'quitAndStop') void quitAndStop();
    else if (action === 'settings') openSettings();
    else if (action === 'checkForUpdates') checkForUpdates();
    else if (action === 'hide') app.hide();
}

/**
 * The keys of a browser view. The workspace keys and the app keys work as in the rest of the window.
 * ⌘R loads the page again, ⌘L selects the address bar and ⌥⌘I opens the developer tools of the page.
 * Returns true when the app used the key.
 */
function browserKey(id: string, input: Electron.Input): boolean {
    const action = shortcutAction(input);
    if (action) {
        sendShortcut(action);
        return true;
    }
    const appAction = appKeyAction(input);
    if (appAction) {
        runAppKey(appAction);
        return true;
    }
    switch (browserViewKey(input)) {
        case 'reload':
            browserViews.reload(id);
            return true;
        case 'focusAddress':
            mainWindow.get()?.webContents.focus();
            mainWindow.send(IpcChannels.browserFocusAddress, id);
            return true;
        case 'devTools':
            browserViews.toggleDevTools(id);
            return true;
        default:
            return false;
    }
}

app.whenReady().then(async () => {
    await services.projects.load();
    // The page reads the onboarding state at its start, so set the first state before the window opens.
    await ensureOnboarding({
        settings,
        hasRepos: async () => (await services.projects.get()).projects.some(project => project.repos.length > 0)
    }).catch(error => console.error('[onboarding] The first onboarding state was not saved:', error));
    mainWindow.applyAppearance((await settings.get()).appearance);
    Menu.setApplicationMenu(
        Menu.buildFromTemplate(
            menuTemplate({
                openSettings: () => openSettings(),
                checkForUpdates,
                quitAndStopSessions: () => void quitAndStop(),
                sendShortcut,
                help: sendHelp,
                openUrl: url => void shell.openExternal(url)
            })
        )
    );
    writeAgentHookFiles(services.hookPaths, services.shellIntegration, join(app.getPath('userData'), 'shell-integration'));
    services.shellAgents.start();
    protocol.handle(
        FILE_SCHEME,
        createFileProtocolHandler(worktree => services.projectWorktrees.check(worktree))
    );
    protocol.handle(
        AZURE_IMAGE_SCHEME,
        createAzureImageHandler((organization, url, accept) => services.reviewProviders.azureFile(organization, url, accept))
    );
    registerIpc(services, runAppKey);
    createWindow();
    void settings
        .get()
        .then(all => services.remote.apply(all.remote))
        .catch(error => console.error('[remote] The phone server did not start:', error));
    // The usage requests need the extra certificates on a network that inspects TLS traffic.
    void services.networkReady.then(() => services.usage.start());
    // The packaged app looks for updates. In development, the user can still check in Settings › About.
    if (app.isPackaged) void services.networkReady.then(() => services.updates.start());
    // Remove the copies of pull requests that the user did not open for a few days.
    void services.shellReady
        .then(() => services.reviewCheckouts.prune())
        .catch(error => console.warn('[review] The old pull request copies were not removed:', error));

    // On macOS, the app stays open with no windows. The agents continue to run.
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    // The terminal sessions stay in the PTY host. Only the connection closes.
    terminals.dispose();
    void services.remote.stop();
    services.usage.stop();
    services.updates.stop();
    services.notes.close();
    services.fileWatcher.dispose();
    services.lsp.stopAll();
    services.tasks.stopAll();
    services.askRunner.cancelAll();
});
