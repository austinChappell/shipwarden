import { basename, join } from 'path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import { IpcChannels, type ConfirmRequest, type ContextMenuItem, type NotificationRequest } from '@shared/api';
import type { CreateTerminalOptions } from '@shared/terminal';
import type { CreatedWorktree, CreateWorktreeOptions, RemoveWorktreeResult } from '@shared/worktrees';
import type { MergeMethod, PendingComment, PullRequestFile, PullRequestFilter, RepoRef, RepoTarget, ReviewEvent } from '@shared/github';
import type { ConnectionChange, TaskLink } from '@shared/tasks';
import * as os from 'os';
import { removeAgentSessionVariables } from './agent-environment';
import { claudeHookSettings, withAgentHooks } from '@shared/agents';
import { writeFileSync } from 'fs';
import { FileService } from './files/file-service';
import { FileWatcher } from './files/file-watcher';
import { GitHubClient } from './github/github-client';
import { GitHubService } from './github/github-service';
import { LspManager } from './lsp/lsp-manager';
import { PluginSettings } from './tasks/plugin-settings';
import { TaskHost } from './tasks/task-host';
import { ProjectStore } from './project-store';
import { loadLoginShellPath, loginShellCaFile } from './shell-env';
import { TrustedCertificates } from './network/trusted-certificates';
import { NotesService } from './notes/notes-service';
import { LEGACY_NAMES, migrateLegacyData } from './legacy-migration';
import { NotificationService } from './notifications';
import { appKeyAction, shortcutAction, type AppKeyAction, type ShortcutAction } from '@shared/shortcuts';
import { networkErrorDetail } from '@shared/network';
import { loadGhosttySettings } from './terminal/ghostty-loader';
import { ptyHostSocketPath } from './pty-host/protocol';
import { PtyHostClient } from './pty-host/pty-host-client';
import { ProcessService } from './processes/process-service';
import { bundlePathOf, UpdateService } from './updates/update-service';
import { GitWorktreeService, worktreesRoot } from './worktrees/git-worktree-service';
import { runScript } from './worktrees/run-script';
import { normalizeWorktreeSettings, resolveWorktreeSettings, scriptEnvironment } from '@shared/worktree-settings';
import { SettingsStore } from './settings-store';
import { SeenStore } from './seen-store';
import { UsageService } from './usage/usage-service';
import { which } from './lsp/servers';
import { commandProgram, type AppSettings, type CommandCheck } from '@shared/settings';
import { activePalette, DEFAULT_APPEARANCE, type Appearance } from '@shared/themes';

// Do this first. Terminals must not inherit the session of an agent that started ShipWarden.
removeAgentSessionVariables(process.env);

// The app was Yardmaster before. Copy its data one time, before the stores below read their files.
const migration = migrateLegacyData({ appData: app.getPath('appData'), userData: app.getPath('userData'), home: os.homedir() });
migration.copied.forEach(item => console.log(`[migration] Copied ${item}`));
migration.errors.forEach(item => console.error(`[migration] ${item}`));

// For automated UI checks: SHIPWARDEN_DEBUG_PORT=9333 opens the Chrome DevTools Protocol on that port.
if (process.env.SHIPWARDEN_DEBUG_PORT) {
    app.commandLine.appendSwitch('remote-debugging-port', process.env.SHIPWARDEN_DEBUG_PORT);
}


let mainWindow: BrowserWindow | undefined;
const worktrees = new GitWorktreeService();
const projects = new ProjectStore(join(app.getPath('userData'), 'projects.json'), join(app.getPath('userData'), 'state.json'));
const files = new FileService();
const fileWatcher = new FileWatcher(event => mainWindow?.webContents.send(IpcChannels.filesChanged, event));
// Language servers need the PATH of the login shell. Load it in the background.
const shellReady = loadLoginShellPath();
const lsp = new LspManager(message => mainWindow?.webContents.send(IpcChannels.lspMessage, message), shellReady);
const certificates = new TrustedCertificates(join(app.getPath('userData'), 'trusted-ca.pem'));
/**
 * The extra CA certificates apply before the first network request. The settings store comes later in this file,
 * but this callback runs after the module loads.
 */
const networkReady: Promise<void> = shellReady
    .then(async () => { await certificates.apply((await settings.get()).network, loginShellCaFile()); })
    .catch(error => console.warn(`[network] The trusted certificates were not applied: ${error instanceof Error ? error.message : String(error)}`));
const githubClient = new GitHubClient(networkReady);
const github = new GitHubService(githubClient);

/** Returns the GitHub repository of the worktree. Throws an error when the worktree has no GitHub remote. */
/** Returns the GitHub repository of a target: a repository from the Review view, or the repository of a worktree. */
async function repoOf(target: RepoTarget): Promise<RepoRef> {
    if (typeof target === 'object' && target && typeof target.owner === 'string' && typeof target.name === 'string') {
        return { owner: target.owner, name: target.name };
    }
    const repo = await github.repoFor(String(target));
    if (!repo) {
        throw new Error('The "origin" remote of this worktree is not a GitHub repository.');
    }
    return repo;
}

const tasks = new TaskHost({
    pluginFolders: [
        // The packaged app keeps the built-in plugins outside the asar archive, because a process cannot start in an archive folder.
        { path: app.isPackaged ? join(process.resourcesPath, 'plugins') : join(app.getAppPath(), 'plugins'), builtIn: true },
        { path: join(os.homedir(), '.shipwarden', 'plugins'), builtIn: false }
    ],
    settings: new PluginSettings(join(app.getPath('userData'), 'plugin-settings.json')),
    repoFor: root => github.repoFor(root),
    projectRepos: async projectId => (await projects.get()).projects.find(project => project.id === projectId)?.repos ?? [],
    configFile: join(app.getPath('userData'), 'task-managers.json'),
    legacySourcesFile: join(app.getPath('userData'), 'task-sources.json'),
    linksFile: join(app.getPath('userData'), 'task-links.json'),
    collectionsFile: join(app.getPath('userData'), 'task-collections.json'),
    selectedConnectionsFile: join(app.getPath('userData'), 'task-selected-connections.json'),
    onChanged: (connectionId, projectId) => mainWindow?.webContents.send(IpcChannels.tasksChanged, connectionId, projectId),
    // A plugin is another process, so it gets the extra certificates as a bundle file.
    pluginEnv: async (): Promise<Record<string, string>> => {
        await networkReady;
        const bundle = certificates.status().bundlePath;
        return bundle ? { NODE_EXTRA_CA_CERTS: bundle } : {};
    }
});

/**
 * The terminal sessions run in the PTY host, a separate process. When the app quits, the host and its agents
 * continue to run. The next app run connects to the same host and shows the sessions again.
 */
const terminals = new PtyHostClient({
    socketPath: ptyHostSocketPath(app.getPath('userData')),
    legacySocketPaths: LEGACY_NAMES.map(name => ptyHostSocketPath(join(app.getPath('appData'), name))),
    hostScript: join(__dirname, 'pty-host.js'),
    logPath: join(app.getPath('userData'), 'pty-host.log'),
    events: {
        data: (id, data, seq) => mainWindow?.webContents.send(IpcChannels.terminalsData, id, data, seq),
        exit: (id, exitCode) => mainWindow?.webContents.send(IpcChannels.terminalsExit, id, exitCode),
        agentState: (id, update) => mainWindow?.webContents.send(IpcChannels.terminalsAgentState, id, update)
    }
});

/** Finds new releases on GitHub and installs them. Only the packaged app installs. */
const updates = new UpdateService({
    version: app.getVersion(),
    bundlePath: bundlePathOf(process.execPath, app.isPackaged),
    token: () => githubClient.optionalToken(),
    tempFolder: join(app.getPath('temp'), 'shipwarden-update'),
    onState: state => mainWindow?.webContents.send(IpcChannels.updatesChanged, state),
    quit: () => app.quit()
});

/** The processes and ports of the worktrees. */
const processes = new ProcessService({ sessions: () => terminals.list(), hostPid: () => terminals.hostPid() });

/**
 * Stops a terminal session and the processes that its shell started. Some processes (for example a server that
 * ignores SIGHUP, or a background job) continue to run when only the shell stops.
 */
async function killTerminal(id: string): Promise<void> {
    const session = (await terminals.list().catch(() => [])).find(item => item.id === id);
    const pids = session?.pid && !session.exited ? await processes.descendantsOf(session.pid).catch(() => []) : [];
    await terminals.kill(id);
    processes.terminate(pids).catch(error => console.error('[processes] Cannot stop the processes of a terminal:', error));
}

/** The plan usage of Claude Code and Codex for the status bar. */
const usage = new UsageService(`ShipWarden/${app.getVersion()}`, list => mainWindow?.webContents.send(IpcChannels.usageChanged, list));
const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'));
const seen = new SeenStore(join(app.getPath('userData'), 'seen.json'));
/** A click on a notification brings the window to the front and tells the page where to go. */
const notifications = new NotificationService(target => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send(IpcChannels.notificationsClicked, target);
    }
});
/** The notes are in the home folder, not the app data folder, so the user and agents can find and open them. */
const notes = new NotesService(join(os.homedir(), '.shipwarden', 'notes'), file => shell.trashItem(file));
const ptyHostLog = join(app.getPath('userData'), 'pty-host.log');

/** The background of a new window: the background of the active theme, so the window does not flash another color. */
let windowBackground = activePalette(DEFAULT_APPEARANCE, true).palette.bg;

/** Makes native parts (menus, dialogs, scroll bars) follow the color scheme, and remembers the window background. */
function applyNativeAppearance(appearance: Appearance): void {
    nativeTheme.themeSource = appearance.scheme;
    windowBackground = activePalette(appearance, nativeTheme.shouldUseDarkColors).palette.bg;
}

/** The worktree settings of a repository: its own settings, else the global settings. */
async function worktreeSettingsFor(repoPath: string) {
    const all = await settings.get();
    return resolveWorktreeSettings(all.worktrees, all.repos[repoPath]?.worktrees, repoPath, worktreesRoot(), os.homedir());
}

/** Finds the program of a command in the login shell PATH. A path with a slash must be an executable file. */
async function checkCommand(command: string): Promise<CommandCheck> {
    await shellReady;
    const program = commandProgram(command);
    if (!program) {
        return { program };
    }
    return { program, path: await which(program) };
}

/** Shows the window and opens the settings page. */
function openSettings(): void {
    if (!mainWindow) {
        createWindow();
    }
    mainWindow?.show();
    mainWindow?.webContents.send(IpcChannels.appOpenSettings);
}

/** The hook settings file that agents get with --settings. It is the same for each session. */
const hookSettingsPath = join(app.getPath('userData'), 'claude-hooks.json');

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 800,
        minHeight: 500,
        show: false,
        title: 'ShipWarden',
        backgroundColor: windowBackground,
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 14, y: 13 },
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    mainWindow.on('ready-to-show', () => mainWindow?.show());
    mainWindow.on('closed', () => {
        mainWindow = undefined;
    });
    // The workspace keys go to the app before the page gets them. A focused terminal takes all keys, so the menu
    // shortcuts alone do not work in a terminal. preventDefault also stops the menu item, so the action happens once.
    mainWindow.webContents.on('before-input-event', (event, input) => {
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
    });
    // Open web links in the default browser, not in a new app window.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    if (process.env.ELECTRON_RENDERER_URL) {
        mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
        mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
    }
}

function registerIpc(): void {
    ipcMain.handle(IpcChannels.projectsGet, () => projects.get());
    ipcMain.handle(IpcChannels.projectsCreate, (_event, name: string) => projects.create(String(name)));
    ipcMain.handle(IpcChannels.projectsRename, (_event, id: string, name: string) => projects.rename(id, String(name)));
    ipcMain.handle(IpcChannels.projectsDelete, (_event, id: string) => projects.delete(id));
    ipcMain.handle(IpcChannels.projectsSetActive, (_event, id: string) => projects.setActive(id));
    ipcMain.handle(IpcChannels.projectsRemoveRepo, (_event, id: string, repo: string) => projects.removeRepo(id, repo));
    ipcMain.handle(IpcChannels.projectsChooseRepo, async (_event, id: string) => {
        const options: Electron.OpenDialogOptions = { title: 'Add Repository', buttonLabel: 'Add', properties: ['openDirectory'] };
        const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length === 0) {
            return projects.get();
        }
        return projects.addRepo(id, result.filePaths[0]);
    });

    ipcMain.handle(IpcChannels.worktreesList, (_event, repoPath: string) => worktrees.list(repoPath));
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
    ipcMain.handle(IpcChannels.worktreesRemove, async (_event, repoPath: string, worktreePath: string, options?: { skipTeardown?: boolean }): Promise<RemoveWorktreeResult> => {
        const config = await worktreeSettingsFor(repoPath);
        // Git does not remove a worktree with changes. Check first, so the teardown and the process stop do not occur for nothing.
        if (await worktrees.uncommittedChanges(worktreePath)) {
            throw new Error('The worktree has uncommitted changes. Commit or remove them first.');
        }
        if (config.teardownScript && !options?.skipTeardown) {
            const main = (await worktrees.list(repoPath)).find(item => item.isMain);
            const worktree = (await worktrees.list(repoPath)).find(item => item.path === worktreePath);
            const env = scriptEnvironment({ rootPath: main?.path ?? repoPath, worktreePath, branch: worktree?.branch, repoName: basename(main?.path ?? repoPath) });
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
    });
    ipcMain.handle(IpcChannels.worktreesPreviewCopy, (_event, repoPath: string, copy: unknown) =>
        worktrees.ignoredMatches(String(repoPath), normalizeWorktreeSettings({ copyIgnored: copy }).copyIgnored));
    ipcMain.handle(IpcChannels.worktreesDefaultFolder, () => worktreesRoot());
    ipcMain.handle(IpcChannels.worktreesDeleteBranch, (_event, repoPath: string, branch: string, force?: boolean) =>
        worktrees.deleteBranch(String(repoPath), String(branch), force === true));
    ipcMain.handle(IpcChannels.appContextMenu, (event, items: ContextMenuItem[]) => new Promise<string | undefined>(resolve => {
        let chosen: string | undefined;
        const template = (Array.isArray(items) ? items : []).map((item): Electron.MenuItemConstructorOptions => ('type' in item
            ? { type: 'separator' }
            : { label: String(item.label), enabled: item.enabled !== false, click: () => { chosen = String(item.id); } }));
        const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
        // The click comes before the close callback, so the callback returns the chosen item.
        Menu.buildFromTemplate(template).popup({ window, callback: () => resolve(chosen) });
    }));
    ipcMain.handle(IpcChannels.worktreesChooseFolder, async () => {
        const options: Electron.OpenDialogOptions = { title: 'Choose a Folder for Worktrees', buttonLabel: 'Choose', properties: ['openDirectory', 'createDirectory'] };
        const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
        return result.canceled ? undefined : result.filePaths[0];
    });

    ipcMain.handle(IpcChannels.filesListDirectory, (_event, root: string, directory: string) => files.listDirectory(root, directory));
    ipcMain.handle(IpcChannels.filesListFiles, (_event, root: string) => files.listFiles(root));
    ipcMain.handle(IpcChannels.filesSearch, (_event, root: string, query: string) => files.searchContents(root, query));
    ipcMain.handle(IpcChannels.filesRead, (_event, root: string, file: string) => files.readFile(root, file));
    ipcMain.handle(IpcChannels.filesReadExternal, (_event, absolutePath: string) => files.readExternal(absolutePath));
    ipcMain.handle(IpcChannels.filesWrite, (_event, root: string, file: string, content: string) => files.writeFile(root, file, content));
    ipcMain.on(IpcChannels.filesWatch, (_event, root: string) => fileWatcher.start(root));
    ipcMain.on(IpcChannels.filesUnwatch, (_event, root: string) => fileWatcher.stop(root));

    ipcMain.handle(IpcChannels.githubStatus, (_event, root: string) => github.branchStatus(root));
    ipcMain.handle(IpcChannels.githubBranchSummaries, (_event, repoPath: string) => github.branchSummaries(repoPath));
    ipcMain.handle(IpcChannels.githubFiles, async (_event, target: RepoTarget, number: number) => github.pullRequestFiles(await repoOf(target), number));
    ipcMain.handle(IpcChannels.githubFileVersions, async (_event, target: RepoTarget, file: PullRequestFile, baseSha: string, headSha: string) =>
        github.fileVersions(await repoOf(target), file, baseSha, headSha));
    ipcMain.handle(IpcChannels.githubSubmitReview, async (_event, target: RepoTarget, number: number, headSha: string, reviewEvent: ReviewEvent, body: string, comments: PendingComment[]) =>
        github.submitReview(await repoOf(target), number, headSha, reviewEvent, body, comments));
    ipcMain.handle(IpcChannels.githubReply, async (_event, target: RepoTarget, number: number, commentId: number, body: string) =>
        github.replyToComment(await repoOf(target), number, commentId, body));
    ipcMain.handle(IpcChannels.githubSetThreadResolved, (_event, threadId: string, resolved: boolean) => github.setThreadResolved(threadId, resolved));
    ipcMain.handle(IpcChannels.githubMerge, async (_event, target: RepoTarget, number: number, headSha: string, method: MergeMethod) =>
        github.merge(await repoOf(target), number, headSha, method));
    ipcMain.handle(IpcChannels.githubChecks, async (_event, target: RepoTarget, sha: string) => github.checks(await repoOf(target), sha));
    ipcMain.handle(IpcChannels.githubJobProgress, async (_event, target: RepoTarget, jobId: number) => github.jobProgress(await repoOf(target), Number(jobId)));
    ipcMain.handle(IpcChannels.githubJobLog, async (_event, target: RepoTarget, jobId: number) => github.jobLog(await repoOf(target), jobId));
    ipcMain.handle(IpcChannels.githubSaveJobLog, async (_event, target: RepoTarget, jobId: number) => github.saveJobLog(await repoOf(target), jobId));
    ipcMain.handle(IpcChannels.githubRerunJob, async (_event, target: RepoTarget, jobId: number) => github.rerunJob(await repoOf(target), jobId));
    ipcMain.handle(IpcChannels.githubRerunFailedJobs, async (_event, target: RepoTarget, runId: number) => github.rerunFailedJobs(await repoOf(target), runId));
    ipcMain.handle(IpcChannels.githubWorkflows, async (_event, target: RepoTarget, ref: string) => github.workflows(await repoOf(target), ref));
    ipcMain.handle(IpcChannels.githubDispatchWorkflow, async (_event, target: RepoTarget, workflowId: number, ref: string, inputs?: Record<string, string>) =>
        github.dispatchWorkflow(await repoOf(target), workflowId, ref, inputs && typeof inputs === 'object' ? inputs : undefined));
    ipcMain.handle(IpcChannels.githubWorkflowRuns, async (_event, target: RepoTarget, workflowId?: number) =>
        github.workflowRuns(await repoOf(target), typeof workflowId === 'number' ? workflowId : undefined));
    ipcMain.handle(IpcChannels.githubRunJobs, async (_event, target: RepoTarget, runId: number) => github.runJobs(await repoOf(target), Number(runId)));
    ipcMain.handle(IpcChannels.githubCancelRun, async (_event, target: RepoTarget, runId: number) => github.cancelRun(await repoOf(target), Number(runId)));
    ipcMain.handle(IpcChannels.githubRerunRun, async (_event, target: RepoTarget, runId: number) => github.rerunRun(await repoOf(target), Number(runId)));
    ipcMain.handle(IpcChannels.githubBranches, async (_event, target: RepoTarget) => github.branches(await repoOf(target)));
    ipcMain.handle(IpcChannels.githubPullRequest, async (_event, target: RepoTarget, number: number) => github.pullRequest(await repoOf(target), number));
    ipcMain.handle(IpcChannels.githubSetFileViewed, (_event, pullRequestId: string, path: string, viewed: boolean) => github.setFileViewed(pullRequestId, path, viewed));
    ipcMain.handle(IpcChannels.githubOwners, () => github.owners());
    ipcMain.handle(IpcChannels.githubRepositories, (_event, owners?: string[]) => github.repositories(owners));
    ipcMain.handle(IpcChannels.githubDashboardPullRequests, (_event, owners: string[] | 'all' | undefined) => github.dashboardPullRequests(owners));
    ipcMain.handle(IpcChannels.githubDashboardComments, (_event, owners: string[] | 'all' | undefined) => github.dashboardComments(owners));
    ipcMain.handle(IpcChannels.seenKeys, () => seen.keys());
    ipcMain.handle(IpcChannels.seenMark, (_event, keys: unknown) => seen.mark(Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : []));
    ipcMain.handle(IpcChannels.githubPullRequests, async (_event, repo: RepoRef, filter: PullRequestFilter, query?: string) =>
        github.pullRequests(await repoOf(repo), filter, query));
    ipcMain.on(IpcChannels.githubOpenInBrowser, (_event, url: string) => {
        // Commit statuses and task descriptions can link to other services, so any web URL is permitted.
        if (/^https?:\/\//.test(url)) {
            shell.openExternal(url);
        }
    });

    ipcMain.handle(IpcChannels.tasksPlugins, () => tasks.plugins());
    ipcMain.handle(IpcChannels.tasksConnections, () => tasks.connections());
    ipcMain.handle(IpcChannels.tasksAddConnection, (_event, pluginId: string, name: string) => tasks.addConnection(String(pluginId), String(name ?? '')));
    ipcMain.handle(IpcChannels.tasksUpdateConnection, (_event, id: string, change: ConnectionChange) => tasks.updateConnection(id, change));
    ipcMain.handle(IpcChannels.tasksSaveConnectionSettings, (_event, id: string, values: Record<string, string | boolean>) => tasks.saveConnectionSettings(id, values));
    ipcMain.handle(IpcChannels.tasksRemoveConnection, (_event, id: string) => tasks.removeConnection(id));
    ipcMain.handle(IpcChannels.tasksScopes, (_event, connectionId: string) => tasks.scopes(connectionId));
    ipcMain.handle(IpcChannels.tasksEnabledConnections, () => tasks.enabledConnections());
    ipcMain.handle(IpcChannels.tasksSource, (_event, connectionId: string, projectId: string) => tasks.source(connectionId, projectId));
    ipcMain.handle(IpcChannels.tasksRequest, (_event, connectionId: string, projectId: string, method: string, params: unknown) =>
        tasks.request(connectionId, projectId, method, params));
    ipcMain.handle(IpcChannels.tasksLinks, () => tasks.allLinks());
    ipcMain.handle(IpcChannels.tasksSelectedCollection, (_event, connectionId: string) => tasks.selectedCollection(connectionId));
    ipcMain.handle(IpcChannels.tasksSetSelectedCollection, (_event, connectionId: string, collectionId: string) =>
        tasks.setSelectedCollection(connectionId, String(collectionId)));
    ipcMain.handle(IpcChannels.tasksSelectedConnection, (_event, projectId: string) => tasks.selectedConnection(projectId));
    ipcMain.handle(IpcChannels.tasksSetSelectedConnection, (_event, projectId: string, connectionId: string) =>
        tasks.setSelectedConnection(projectId, String(connectionId)));
    ipcMain.handle(IpcChannels.tasksSetLink, (_event, worktreePath: string, link: TaskLink | null) => tasks.setLink(worktreePath, link));

    ipcMain.handle(IpcChannels.lspEnsure, (_event, root: string, languageId: string) => lsp.ensure(root, languageId));
    ipcMain.handle(IpcChannels.lspRequest, (_event, key: string, method: string, params: unknown) => lsp.request(key, method, params));
    ipcMain.on(IpcChannels.lspNotify, (_event, key: string, method: string, params: unknown) => lsp.notify(key, method, params));

    ipcMain.handle(IpcChannels.terminalsSettings, () => loadGhosttySettings());
    ipcMain.handle(IpcChannels.terminalsList, () => terminals.list());
    ipcMain.handle(IpcChannels.terminalsCreate, (_event, options: CreateTerminalOptions) => {
        const command = options.isAgent && options.command ? withAgentHooks(options.command, hookSettingsPath) : options.command;
        // Only an agent that got the hooks reports its state.
        return terminals.create({ ...options, command, reportsAgentState: !!options.isAgent && command !== options.command }, process.env);
    });
    ipcMain.handle(IpcChannels.appInfo, () => ({ version: app.getVersion(), dataFolder: app.getPath('userData'), ptyHostLog }));
    ipcMain.handle(IpcChannels.usageGet, () => usage.get());
    ipcMain.handle(IpcChannels.usageRefresh, () => usage.refresh(true));
    ipcMain.handle(IpcChannels.settingsGet, () => settings.get());
    ipcMain.handle(IpcChannels.settingsUpdate, async (_event, change: Partial<AppSettings>) => {
        const before = await settings.get();
        const next = await settings.update(change);
        applyNativeAppearance(next.appearance);
        if (JSON.stringify(before.network) !== JSON.stringify(next.network)) {
            await certificates.apply(next.network, loginShellCaFile());
            // The plugins read NODE_EXTRA_CA_CERTS when they start. They start again at the next request.
            await tasks.stopAll();
        }
        return next;
    });
    ipcMain.on(IpcChannels.notificationsShow, (_event, request: NotificationRequest) => {
        if (request && typeof request === 'object' && typeof request.title === 'string') notifications.show(request);
    });
    ipcMain.on(IpcChannels.notificationsPlaySound, (_event, name: string) => notifications.playSound(String(name)));
    ipcMain.handle(IpcChannels.notesFolder, () => notes.folder);
    ipcMain.handle(IpcChannels.notesList, () => notes.list());
    ipcMain.handle(IpcChannels.notesFolders, () => notes.folders());
    ipcMain.handle(IpcChannels.notesCreateFolder, (_event, name: string) => notes.createFolder(String(name)));
    ipcMain.handle(IpcChannels.notesRenameFolder, (_event, name: string, newName: string) => notes.renameFolder(String(name), String(newName)));
    ipcMain.handle(IpcChannels.notesDeleteFolder, (_event, name: string) => notes.deleteFolder(String(name)));
    ipcMain.handle(IpcChannels.notesRead, (_event, name: string) => notes.read(String(name)));
    ipcMain.handle(IpcChannels.notesWrite, (_event, name: string, content: string) => notes.write(String(name), String(content)));
    ipcMain.handle(IpcChannels.notesCreate, (_event, name: string, content?: string) => notes.create(String(name), typeof content === 'string' ? content : ''));
    ipcMain.handle(IpcChannels.notesRename, (_event, name: string, newName: string) => notes.rename(String(name), String(newName)));
    ipcMain.handle(IpcChannels.notesDelete, (_event, name: string) => notes.delete(String(name)));
    ipcMain.handle(IpcChannels.notesSetTags, (_event, name: string, tags: unknown) => notes.setTags(String(name), Array.isArray(tags) ? tags : []));
    ipcMain.on(IpcChannels.notesReveal, (_event, name?: string) => {
        if (typeof name === 'string' && name) {
            shell.showItemInFolder(notes.pathOf(name));
        } else {
            void shell.openPath(notes.folder);
        }
    });
    void notes.watch(() => mainWindow?.webContents.send(IpcChannels.notesChanged)).catch(error =>
        console.warn(`[notes] The notes folder is not watched: ${error instanceof Error ? error.message : String(error)}`));
    ipcMain.handle(IpcChannels.networkStatus, async () => {
        await networkReady;
        return { ...certificates.status(), shellFile: loginShellCaFile() };
    });
    ipcMain.handle(IpcChannels.networkTest, async () => {
        await networkReady;
        const hosts = [{ name: 'GitHub', url: 'https://api.github.com/' }, { name: 'ClickUp', url: 'https://api.clickup.com/' }];
        return Promise.all(hosts.map(async host => {
            try {
                // Any HTTP answer shows that the TLS connection works. The status code does not matter.
                await fetch(host.url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
                return { name: host.name, ok: true };
            } catch (error) {
                return { name: host.name, ok: false, error: networkErrorDetail(error) };
            }
        }));
    });
    ipcMain.handle(IpcChannels.networkChooseCaFile, async () => {
        const options: Electron.OpenDialogOptions = {
            title: 'Choose a CA Certificates File',
            buttonLabel: 'Choose',
            properties: ['openFile', 'showHiddenFiles'],
            filters: [{ name: 'Certificates', extensions: ['pem', 'crt', 'cer'] }, { name: 'All Files', extensions: ['*'] }]
        };
        const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
        return result.canceled ? undefined : result.filePaths[0];
    });
    ipcMain.handle(IpcChannels.settingsCheckCommand, (_event, command: string) => checkCommand(String(command)));
    ipcMain.on(IpcChannels.appFocus, () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            app.focus({ steal: true });
        }
    });
    ipcMain.handle(IpcChannels.terminalsReplay, (_event, id: string) => terminals.replay(id));
    ipcMain.handle(IpcChannels.updatesState, () => updates.getState());
    ipcMain.handle(IpcChannels.updatesCheck, () => updates.check());
    ipcMain.handle(IpcChannels.updatesInstall, () => updates.install());
    ipcMain.on(IpcChannels.appRunKey, (_event, action: unknown) => {
        if (action === 'quit' || action === 'quitAndStop' || action === 'settings' || action === 'hide') runAppKey(action);
    });
    ipcMain.on(IpcChannels.appConfirmAnswer, (_event, id: number, confirmed: boolean) => confirmAnswers.get(Number(id))?.(confirmed === true));
    ipcMain.handle(IpcChannels.terminalsKill, (_event, id: string) => killTerminal(String(id)));
    ipcMain.handle(IpcChannels.processesList, (_event, worktreePaths: unknown) =>
        processes.scan(Array.isArray(worktreePaths) ? worktreePaths.filter((item): item is string => typeof item === 'string') : []));
    ipcMain.handle(IpcChannels.processesStop, (_event, worktreePath: string, pid: number) => processes.stop(String(worktreePath), Number(pid)));
    ipcMain.on(IpcChannels.terminalsWrite, (_event, id: string, data: string) => terminals.write(id, data));
    ipcMain.on(IpcChannels.terminalsResize, (_event, id: string, cols: number, rows: number) => terminals.resize(id, cols, rows));
}

let confirmCounter = 0;
const confirmAnswers = new Map<number, (confirmed: boolean) => void>();

/**
 * Asks the user a question in the dialog of the page, so it has the style of the app. Without a loaded window,
 * a native dialog asks.
 */
async function askUser(request: ConfirmRequest): Promise<boolean> {
    const window = mainWindow;
    if (!window || window.isDestroyed() || window.webContents.isLoading()) {
        const options: Electron.MessageBoxOptions = {
            type: 'warning',
            message: request.title,
            detail: request.message,
            buttons: [request.confirmLabel ?? 'OK', request.cancelLabel ?? 'Cancel'],
            defaultId: 1,
            cancelId: 1
        };
        return (await dialog.showMessageBox(options)).response === 0;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    confirmCounter += 1;
    const id = confirmCounter;
    return new Promise(resolve => {
        const done = (confirmed: boolean) => {
            confirmAnswers.delete(id);
            window.removeListener('closed', onClosed);
            resolve(confirmed);
        };
        // A closed window gives no answer. That is "no".
        const onClosed = () => done(false);
        window.once('closed', onClosed);
        confirmAnswers.set(id, done);
        window.webContents.send(IpcChannels.appConfirmRequest, id, request);
    });
}

/**
 * Stops all terminal sessions and the PTY host, then quits.
 * The app asks first when sessions run, because the agents lose their work in progress.
 */
async function quitAndStopSessions(): Promise<void> {
    const running = terminals.isConnected() ? (await terminals.list().catch(() => [])).filter(session => !session.exited) : [];
    if (running.length > 0) {
        const agents = running.filter(session => session.isAgent).length;
        const shells = running.length - agents;
        const parts = [agents ? `${agents} ${agents === 1 ? 'agent' : 'agents'}` : '', shells ? `${shells} ${shells === 1 ? 'shell' : 'shells'}` : ''].filter(Boolean);
        const confirmed = await askUser({
            title: `Stop ${parts.join(' and ')} and quit?`,
            message: 'The processes stop now. Work that an agent did not finish stops too. A normal Quit (⌘Q) keeps the sessions running.',
            confirmLabel: 'Stop and Quit',
            danger: true
        });
        if (!confirmed) {
            return;
        }
    }
    await terminals.shutdownHost();
    app.quit();
}

/** Runs an app key of the macOS menu: ⌘Q, ⇧⌥⌘Q, ⌘, or ⌘H. */
function runAppKey(action: AppKeyAction): void {
    if (action === 'quit') app.quit();
    else if (action === 'quitAndStop') void quitAndStopSessions();
    else if (action === 'settings') openSettings();
    else if (action === 'hide') app.hide();
}

function sendShortcut(action: ShortcutAction): void {
    mainWindow?.webContents.send(IpcChannels.appShortcut, action);
}

/** The macOS menu. It is the standard menu, with "Quit and Stop All Agents" after "Quit". */
function buildMenu(): void {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            role: 'appMenu',
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { label: 'Settings…', accelerator: 'CommandOrControl+,', click: openSettings },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit', label: 'Quit ShipWarden (Keep Agents Running)' },
                // macOS gives ⌥⌘Q to its "Quit and Keep Windows" item, so this item uses ⇧⌥⌘Q.
                { label: 'Quit and Stop All Agents…', accelerator: 'Shift+Alt+Command+Q', click: () => void quitAndStopSessions() }
            ]
        },
        {
            label: 'File',
            submenu: [
                // The same keys as Ghostty. ⌘W closes a pane, so the window closes with ⇧⌘W.
                { label: 'New Shell Tab', accelerator: 'Command+T', click: () => sendShortcut('newTab') },
                { label: 'Split Right', accelerator: 'Command+D', click: () => sendShortcut('right') },
                { label: 'Split Down', accelerator: 'Shift+Command+D', click: () => sendShortcut('down') },
                { type: 'separator' },
                { label: 'Select Previous Split', accelerator: 'Command+[', click: () => sendShortcut('previous') },
                { label: 'Select Next Split', accelerator: 'Command+]', click: () => sendShortcut('next') },
                { type: 'separator' },
                { label: 'Close Pane', accelerator: 'Command+W', click: () => sendShortcut('close') },
                { role: 'close', label: 'Close Window', accelerator: 'Shift+Command+W' }
            ]
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' }
    ]));
}

app.whenReady().then(async () => {
    await projects.load();
    applyNativeAppearance((await settings.get()).appearance);
    buildMenu();
    try {
        writeFileSync(hookSettingsPath, JSON.stringify(claudeHookSettings(), null, 2));
    } catch (error) {
        // Without the hook settings, agents still run. ShipWarden then shows no agent state.
        console.warn(`[agents] The hook settings were not written: ${error instanceof Error ? error.message : String(error)}`);
    }
    registerIpc();
    createWindow();
    // The usage requests need the extra certificates on a network that inspects TLS traffic.
    void networkReady.then(() => usage.start());
    // The packaged app looks for updates. In development, the user can still check in Settings › About.
    if (app.isPackaged) void networkReady.then(() => updates.start());

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
    usage.stop();
    updates.stop();
    notes.close();
    fileWatcher.dispose();
    lsp.stopAll();
    tasks.stopAll();
});
