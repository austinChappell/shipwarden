import { join } from 'path';
import { mkdirSync } from 'fs';
import { stat } from 'fs/promises';
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

/**
 * Opens a main window. Each window shows its own page, so the user can see one view in a window and another view in a
 * second window (⇧⌘N).
 */
function createWindow(): BrowserWindow {
    return mainWindow.create({
        preload: join(__dirname, '../preload/index.js'),
        devServerUrl: process.env.ELECTRON_RENDERER_URL,
        page: join(__dirname, '../renderer/index.html'),
        onClosed: window => browserViews.destroyOwnedBy(window),
        // The workspace keys go to the app before the page gets them. A focused terminal takes all keys, so the menu
        // shortcuts alone do not work in a terminal. preventDefault also stops the menu item, so the action happens once.
        onInput: (window, event, input) => {
            const action = shortcutAction(input);
            if (action) {
                event.preventDefault();
                sendShortcut(action, window);
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

/** Returns the window that had the focus last. Without a window, it opens a new window. */
function activeWindow(): BrowserWindow {
    return mainWindow.get() ?? createWindow();
}

/** Shows the active window and opens the settings page. A section, for example "about", opens that section. */
function openSettings(section?: string): void {
    const window = activeWindow();
    window.show();
    window.webContents.send(IpcChannels.appOpenSettings, section);
}

/**
 * Checks for updates and does not change the page. The page shows the result in a notice that closes after a few
 * seconds. A failed check also goes to the page as a state with the "error" status.
 */
function checkForUpdates(): void {
    const window = activeWindow();
    window.show();
    void services.updates.check().then(
        state => {
            if (!window.isDestroyed()) window.webContents.send(IpcChannels.updatesChecked, state);
        },
        () => undefined
    );
}

/** Shows the active window and sends an item of the Help menu to its page. */
function sendHelp(action: HelpAction): void {
    const window = activeWindow();
    window.show();
    window.webContents.send(IpcChannels.appHelp, action);
}

/** Sends a workspace key to the page of a window. Without a window, the key goes to the window that had the focus last. */
function sendShortcut(action: ShortcutAction, window: BrowserWindow | undefined = mainWindow.get()): void {
    if (window && !window.isDestroyed()) window.webContents.send(IpcChannels.appShortcut, action);
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

/** Runs an app key of the macOS menu: ⌘Q, ⇧⌥⌘Q, ⌘, ⇧⌘U, ⌘H or ⇧⌘N. */
function runAppKey(action: AppKeyAction): void {
    if (action === 'quit') app.quit();
    else if (action === 'newWindow') createWindow();
    else if (action === 'quitAndStop') void quitAndStop();
    else if (action === 'settings') openSettings();
    else if (action === 'checkForUpdates') checkForUpdates();
    else if (action === 'hide') app.hide();
}

/**
 * The keys of a browser view. The workspace keys and the app keys work as in the rest of the window.
 * ⌘R loads the page again, ⌘L selects the address bar, ⌘F opens the find bar and ⌥⌘I opens the developer tools of the page.
 * Returns true when the app used the key.
 */
function browserKey(id: string, input: Electron.Input): boolean {
    const window = browserViews.ownerOf(id);
    const action = shortcutAction(input);
    if (action) {
        sendShortcut(action, window);
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
            window?.webContents.focus();
            window?.webContents.send(IpcChannels.browserFocusAddress, id);
            return true;
        case 'find':
            window?.webContents.focus();
            window?.webContents.send(IpcChannels.browserFindOpen, id);
            return true;
        case 'devTools':
            browserViews.toggleDevTools(id);
            return true;
        default:
            return false;
    }
}

/**
 * Returns the oldest creation time of the data files, or now when no file exists. A current user gets the time of the
 * first start of the app. A new user gets now.
 */
async function firstUseTime(userData: string): Promise<number> {
    const times = await Promise.all(
        ['settings.json', 'projects.json'].map(name =>
            stat(join(userData, name)).then(
                info => info.birthtimeMs,
                () => undefined
            )
        )
    );
    const known = times.filter((time): time is number => time !== undefined && time > 0);
    return known.length > 0 ? Math.min(...known) : Date.now();
}

app.whenReady().then(async () => {
    await services.projects.load();
    // The page reads the onboarding state at its start, so set the first state before the window opens.
    await ensureOnboarding({
        settings,
        hasRepos: async () => (await services.projects.get()).projects.some(project => project.repos.length > 0),
        firstUseTime: () => firstUseTime(app.getPath('userData'))
    }).catch(error => console.error('[onboarding] The first onboarding state was not saved:', error));
    mainWindow.applyAppearance((await settings.get()).appearance);
    Menu.setApplicationMenu(
        Menu.buildFromTemplate(
            menuTemplate({
                openSettings: () => openSettings(),
                checkForUpdates,
                newWindow: () => void createWindow(),
                quitAndStopSessions: () => void quitAndStop(),
                sendShortcut,
                help: sendHelp,
                openUrl: url => void shell.openExternal(url)
            })
        )
    );
    writeAgentHookFiles(services.hookPaths, services.shellIntegration, join(app.getPath('userData'), 'shell-integration'));
    services.shellAgents.start();
    services.staleShells.start();
    void services.pruneOldCheckpoints().catch(error => console.warn('[checkpoints] The cleanup failed:', error));
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
    services.staleShells.stop();
    services.updates.stop();
    services.notes.close();
    services.fileWatcher.dispose();
    services.lsp.stopAll();
    services.tasks.stopAll();
    services.askRunner.cancelAll();
});
