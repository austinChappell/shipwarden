import { basename, join } from 'path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, shell } from 'electron';
import { IpcChannels, type ConfirmRequest, type NotificationRequest } from '@shared/api';
import type { CreateTerminalOptions } from '@shared/terminal';
import type { CreatedWorktree, CreateWorktreeOptions, RemoveWorktreeResult } from '@shared/worktrees';
import type { MergeMethod, NewPullRequest, PendingComment, PullRequestChange, PullRequestFile, PullRequestFilter, RepoRef, RepoTarget, ReviewEvent } from '@shared/github';
import type { ReviewProviderChange, ReviewProviderKind } from '@shared/review-providers';
import { ReviewProviders } from './review-providers';
import type { ConnectionChange, TaskLink } from '@shared/tasks';
import * as os from 'os';
import { removeAgentSessionVariables } from './agent-environment';
import { claudeHookSettings, opencodeHookConfig, withAgentHooks, type HookSettingsPaths } from '@shared/agents';
import { writeGeminiHookSettings } from './agents/gemini-settings';
import { writeOpencodePlugin } from './agents/opencode-plugin';
import { shellIntegrationEnv, writeZshIntegration, type ShellIntegration } from './agents/shell-integration';
import { ShellAgents } from './agents/shell-agents';
import { AskAgentRunner } from './agents/ask-agent';
import { folderNote, isWorktreeAsk, printCommand, type AskAgentRequest, type AskAgentResult } from '@shared/ask-agent';
import { writeFileSync } from 'fs';
import { mkdir } from 'fs/promises';
import { detectKind, FileService, resolveInside } from './files/file-service';
import { createFileProtocolHandler } from './files/file-protocol';
import { FILE_SCHEME } from '@shared/file-url';
import { isMediaKind } from '@shared/file-types';
import { FileWatcher } from './files/file-watcher';
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
import { buildSocketPath, ptyHostSocketFolder, ptyHostSocketPath } from './pty-host/protocol';
import { hostBuildId, PtyHostClient } from './pty-host/pty-host-client';
import { ProcessService } from './processes/process-service';
import { bundlePathOf, UpdateService } from './updates/update-service';
import { GitChangesService } from './git/git-changes-service';
import { GitWorktreeService, worktreesRoot } from './worktrees/git-worktree-service';
import { runScript } from './worktrees/run-script';
import { normalizeWorktreeSettings, resolveWorktreeSettings, scriptEnvironment } from '@shared/worktree-settings';
import { SettingsStore } from './settings-store';
import { SeenStore } from './seen-store';
import { AnswersStore, CodeAnswersStore } from './answers-store';
import { ReviewCheckouts } from './review/review-checkouts';
import { checkCommitSha, checkPullNumber, checkRepoRef } from '@shared/review-checkout';
import { UsageService } from './usage/usage-service';
import { which } from './lsp/servers';
import { agentForRepo, commandProgram, type AppSettings, type CommandCheck } from '@shared/settings';
import { activePalette, DEFAULT_APPEARANCE, type Appearance } from '@shared/themes';
import { execFile } from 'child_process';
import { RemoteDevices } from './remote/remote-devices';
import { localHosts, RemoteServer } from './remote/remote-server';
import { RemoteSnapshotBuilder } from './remote/remote-snapshot';
import { ensureTlsIdentity } from './remote/tls-identity';
import { BrowserViews } from './browser/browser-views';
import type { BrowserBounds } from '@shared/browser';

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

// The viewers of images, PDF, audio and video files get the files through this protocol.
// The scheme must be privileged before the app is ready. "stream" lets <video> and <audio> read byte ranges.
protocol.registerSchemesAsPrivileged([
    { scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);
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
/** The in-app browser. Each browser tab of the page has a WebContentsView in the main window. */
const browserViews = new BrowserViews(() => mainWindow, () => certificates.extraCertificates(), {
    onState: state => mainWindow?.webContents.send(IpcChannels.browserStateChanged, state),
    onOpenTab: (url, openerId) => mainWindow?.webContents.send(IpcChannels.browserOpenTab, url, openerId),
    onFocus: id => mainWindow?.webContents.send(IpcChannels.browserFocused, id),
    onInput: (id, input) => browserKey(id, input)
});
/**
 * The code review providers (GitHub and Azure DevOps accounts). Each pull request and pipeline call goes to the provider
 * of its target. The clients use the same trusted certificates as the in-app browser (`networkReady`).
 */
const reviewProviders = new ReviewProviders({
    file: join(app.getPath('userData'), 'review-providers.json'),
    // The file of the old Azure DevOps token, so that the migration of an older version keeps the token.
    secretsFile: join(app.getPath('userData'), 'source-host-secrets.json'),
    ready: networkReady,
    legacyReviewOwners: async () => (await settings.get()).reviewOwners,
    onChanged: () => mainWindow?.webContents.send(IpcChannels.reviewProvidersChanged)
});

const tasks = new TaskHost({
    pluginFolders: [
        // The packaged app keeps the built-in plugins outside the asar archive, because a process cannot start in an archive folder.
        { path: app.isPackaged ? join(process.resourcesPath, 'plugins') : join(app.getAppPath(), 'plugins'), builtIn: true },
        { path: join(os.homedir(), '.shipwarden', 'plugins'), builtIn: false }
    ],
    settings: new PluginSettings(join(app.getPath('userData'), 'plugin-settings.json')),
    repoFor: root => reviewProviders.githubRepoFor(root),
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
const ptyHostScript = join(__dirname, 'pty-host.js');
const terminals = new PtyHostClient({
    // Each build has its own host. A host of an older build keeps its sessions, and new sessions use this build.
    socketPath: buildSocketPath(ptyHostSocketFolder(app.getPath('userData')), hostBuildId(ptyHostScript)),
    olderSocketPaths: [
        ptyHostSocketPath(app.getPath('userData')),
        ...LEGACY_NAMES.map(name => ptyHostSocketPath(join(app.getPath('appData'), name)))
    ],
    hostScript: ptyHostScript,
    logPath: join(app.getPath('userData'), 'pty-host.log'),
    events: {
        data: (id, data, seq) => {
            mainWindow?.webContents.send(IpcChannels.terminalsData, id, data, seq);
            remote.terminalData(id, data, seq);
        },
        exit: (id, exitCode) => {
            shellAgents.forget(id);
            mainWindow?.webContents.send(IpcChannels.terminalsExit, id, exitCode);
            remote.terminalExited(id);
        },
        agentState: (id, update) => {
            mainWindow?.webContents.send(IpcChannels.terminalsAgentState, id, update);
            remote.agentsChanged();
        }
    }
});

/** Finds new releases on GitHub and installs them. Only the packaged app installs. */
const updates = new UpdateService({
    version: app.getVersion(),
    bundlePath: bundlePathOf(process.execPath, app.isPackaged),
    token: () => reviewProviders.optionalGitHubToken(),
    tempFolder: join(app.getPath('temp'), 'shipwarden-update'),
    onState: state => mainWindow?.webContents.send(IpcChannels.updatesChanged, state),
    quit: () => app.quit()
});

/** The local git changes of the worktrees: status, stage, commit and push. */
const gitChanges = new GitChangesService(file => shell.trashItem(file));

/** The processes and ports of the worktrees. */
const processes = new ProcessService({ sessions: () => terminals.list(), hostPids: () => terminals.hostPids() });

/** Finds the agents that the user starts in a shell tab, for example with `claude` or `codex`. */
const shellAgents = new ShellAgents({
    sessions: () => terminals.isConnected() ? terminals.list() : Promise.resolve([]),
    hostPids: () => terminals.hostPids(),
    processTable: () => processes.table(),
    onState: (id, update) => {
        mainWindow?.webContents.send(IpcChannels.terminalsAgentState, id, update);
        remote.agentsChanged();
    },
    onProgram: (id, program) => {
        mainWindow?.webContents.send(IpcChannels.terminalsAgentProgram, id, program ?? null);
        remote.agentsChanged();
    }
});

/** The sessions of the PTY host, with the agents that the app found in shell tabs. */
const terminalSessions = async () => shellAgents.annotate(await terminals.list());

/**
 * Stops a terminal session and the processes that its shell started. Some processes (for example a server that
 * ignores SIGHUP, or a background job) continue to run when only the shell stops.
 */
async function killTerminal(id: string): Promise<void> {
    const session = (await terminals.list().catch(() => [])).find(item => item.id === id);
    const pids = session?.pid && !session.exited ? await processes.descendantsOf(session.pid).catch(() => []) : [];
    await terminals.kill(id);
    shellAgents.forget(id);
    remote.agentsChanged();
    processes.terminate(pids).catch(error => console.error('[processes] Cannot stop the processes of a terminal:', error));
}

/** The plan usage of Claude Code and Codex for the status bar. */
const usage = new UsageService(`ShipWarden/${app.getVersion()}`, list => mainWindow?.webContents.send(IpcChannels.usageChanged, list));
const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'));
const seen = new SeenStore(join(app.getPath('userData'), 'seen.json'));
const answers = new AnswersStore(join(app.getPath('userData'), 'agent-answers.json'));
/** The local copies of pull requests for go to definition and the file explorer in the Review view. */
const reviewCheckouts = new ReviewCheckouts({
    folder: join(os.homedir(), '.shipwarden', 'review'),
    indexFile: join(app.getPath('userData'), 'review-checkouts.json'),
    findClone: repo => localClone(repo)
});
const codeAnswers = new CodeAnswersStore(join(app.getPath('userData'), 'agent-code-answers.json'));
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

/**
 * The terminal sizes that the page sent. A session of an older PTY host has no size, and the phone's screen copy
 * needs the size of the terminal.
 */
const terminalSizes = new Map<string, { cols: number; rows: number }>();

/** The name of the Mac for the phone, for example "Austin's MacBook Pro". `scutil` reads it at the start. */
let computerName = os.hostname().replace(/\.local$/, '');
execFile('/usr/sbin/scutil', ['--get', 'ComputerName'], (error, stdout) => {
    if (!error && stdout.trim()) computerName = stdout.trim();
});
/** The Bonjour name of the Mac, for example "MacBook-Pro-5". The phone finds the Mac as "<name>.local". */
let localHostName: string | undefined;
execFile('/usr/sbin/scutil', ['--get', 'LocalHostName'], (error, stdout) => {
    if (!error && stdout.trim()) localHostName = stdout.trim();
});

const remoteSnapshot = new RemoteSnapshotBuilder({
    projects: () => projects.get(),
    worktrees: async repo => (await worktrees.list(repo)).filter(item => !reviewCheckouts.isInFolder(item.path)),
    settings: () => settings.get(),
    taskLinks: () => tasks.allLinks(),
    pullRequests: repo => reviewProviders.branchSummaries(repo),
    sessions: terminalSessions
});

/** The HTTPS server for the phone app. It runs only while Settings › Mobile has it on. */
const remote = new RemoteServer({
    devices: new RemoteDevices(join(app.getPath('userData'), 'remote-devices.json')),
    identity: () => ensureTlsIdentity(app.getPath('userData')),
    hosts: () => localHosts(localHostName),
    backend: {
        macName: () => computerName,
        version: app.getVersion(),
        snapshot: () => remoteSnapshot.build(),
        // The size from the page is newer than the size of an older PTY host, which has none.
        sessions: async () => (await terminalSessions()).map(session => ({ ...session, ...terminalSizes.get(session.id) })),
        replay: id => terminals.replay(id),
        write: (id, data) => terminals.write(id, data),
        approvePullRequest: async (worktreePath, number, headSha, body) => {
            const worktree = await knownWorktree(worktreePath);
            await (await reviewProviders.for(worktree)).submitReview(worktree, number, headSha, 'APPROVE', body, []);
            remoteSnapshot.invalidate();
        },
        onStatusChanged: () => mainWindow?.webContents.send(IpcChannels.remoteChanged)
    }
});

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

// The renderer can name only a worktree of the projects, so git does not run in other folders.
// The known worktree paths are kept, and read again only for a path that is not in the list.
const knownWorktrees = new Set<string>();
const knownWorktree = async (worktree: unknown): Promise<string> => {
    const value = String(worktree);
    if (knownWorktrees.has(value)) return value;
    // The copy of a pull request in the Review view. It can be in a clone that is not a project.
    if (await reviewCheckouts.has(value)) return value;
    const repos = (await projects.get()).projects.flatMap(project => project.repos);
    for (const repo of repos) {
        (await worktrees.list(repo).catch(() => [])).forEach(item => knownWorktrees.add(item.path));
    }
    if (knownWorktrees.has(value)) return value;
    throw new Error(`"${value}" is not a worktree of a project.`);
};

const askRunner = new AskAgentRunner();

/** Returns the main worktree of a project repository whose "origin" remote is the GitHub repository. */
async function localClone(repo: RepoRef): Promise<string | undefined> {
    const repos = [...new Set((await projects.get()).projects.flatMap(project => project.repos))];
    for (const root of repos) {
        const ref = await reviewProviders.githubRepoFor(root).catch(() => null);
        if (ref && ref.owner.toLowerCase() === repo.owner.toLowerCase() && ref.name.toLowerCase() === repo.name.toLowerCase()) {
            return root;
        }
    }
    return undefined;
}

/** Returns the project repository of a worktree, or undefined when no project has the worktree. */
async function repoOfWorktree(worktree: string): Promise<string | undefined> {
    const repos = [...new Set((await projects.get()).projects.flatMap(project => project.repos))];
    for (const repo of repos) {
        if ((await worktrees.list(repo).catch(() => [])).some(item => item.path === worktree)) return repo;
    }
    return undefined;
}

/**
 * Asks an agent a question in print mode, and returns the answer.
 * - A question about a pull request (the "Ask agent" box of the Review view): the agent of the local clone applies,
 *   else the default agent. Without a local clone, the agent runs in an empty folder.
 * - A question about a file in a worktree (the "Ask agent" box of the editor): the agent of the repository of the
 *   worktree applies, else the default agent. The agent runs in the worktree.
 */
async function askAgent(request: AskAgentRequest): Promise<AskAgentResult> {
    await shellReady;
    let repoPath: string | undefined;
    let cwd: string | undefined;
    let prompt: string;
    if (isWorktreeAsk(request)) {
        cwd = await knownWorktree(request.worktree);
        repoPath = await repoOfWorktree(cwd);
        prompt = String(request.prompt ?? '');
    } else {
        const repo = { owner: String(request?.repo?.owner ?? ''), name: String(request?.repo?.name ?? '') };
        repoPath = await localClone(repo);
        cwd = repoPath;
        // The note goes first, because the end of the prompt can say how to answer.
        prompt = `${folderNote(!!repoPath, String(request?.headRefOid ?? ''))}\n\n${String(request?.prompt ?? '')}`;
    }
    const agent = agentForRepo(await settings.get(), repoPath);
    const command = printCommand(agent.command);
    if (!command) {
        throw new Error(`ShipWarden can ask only Claude Code, Codex, Gemini CLI or opencode. The agent "${agent.name}" runs "${agent.command}". Select a different agent in Settings › Agents.`);
    }
    if (!cwd) {
        cwd = join(app.getPath('temp'), 'shipwarden-ask');
        await mkdir(cwd, { recursive: true });
    }
    await networkReady;
    const bundle = certificates.status().bundlePath;
    const answer = await askRunner.run(String(request?.id ?? ''), { command, prompt, cwd, env: bundle ? { NODE_EXTRA_CA_CERTS: bundle } : {} });
    return { agent: agent.name, answer };
}

/**
 * The hook settings files of the agents. They are the same for each session.
 * Claude Code gets its file with --settings. Gemini CLI gets its file in GEMINI_CLI_SYSTEM_DEFAULTS_PATH.
 * opencode gets an inline config in OPENCODE_CONFIG_CONTENT that loads the plugin file.
 */
const hookSettingsPaths: HookSettingsPaths = {
    claude: join(app.getPath('userData'), 'claude-hooks.json'),
    gemini: join(app.getPath('userData'), 'gemini-hooks.json'),
    opencode: join(app.getPath('userData'), 'opencode', 'shipwarden-agent-state.js')
};

/** The shell setup that adds the hook settings to a `claude`, `gemini` or `opencode` that the user types in a shell tab. */
const shellIntegration: ShellIntegration = { hookSettingsPath: hookSettingsPaths.claude, geminiHookSettingsPath: hookSettingsPaths.gemini };

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
            sandbox: true,
            // The built-in PDF viewer of Chromium is a plugin. Without this option, a PDF frame stays empty.
            plugins: true
        }
    });
    mainWindow.on('ready-to-show', () => mainWindow?.show());
    mainWindow.on('closed', () => {
        browserViews.destroyAll();
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
    ipcMain.handle(IpcChannels.projectsMove, (_event, id: string, toIndex: number) => projects.move(id, Number(toIndex)));
    ipcMain.handle(IpcChannels.projectsMoveRepo, (_event, id: string, repo: string, toIndex: number) => projects.moveRepo(id, repo, Number(toIndex)));
    ipcMain.handle(IpcChannels.projectsChooseRepo, async (_event, id: string) => {
        const options: Electron.OpenDialogOptions = { title: 'Add Repository', buttonLabel: 'Add', properties: ['openDirectory'] };
        const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length === 0) {
            return projects.get();
        }
        return projects.addRepo(id, result.filePaths[0]);
    });

    // The copies of pull requests for the Review view are worktrees too, but the sidebar does not show them.
    ipcMain.handle(IpcChannels.worktreesList, async (_event, repoPath: string) =>
        worktrees.withDates((await worktrees.list(repoPath)).filter(item => !reviewCheckouts.isInFolder(item.path))));
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
    ipcMain.handle(IpcChannels.worktreesChooseFolder, async () => {
        const options: Electron.OpenDialogOptions = { title: 'Choose a Folder for Worktrees', buttonLabel: 'Choose', properties: ['openDirectory', 'createDirectory'] };
        const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
        return result.canceled ? undefined : result.filePaths[0];
    });

    ipcMain.handle(IpcChannels.filesListDirectory, (_event, root: string, directory: string) => files.listDirectory(root, directory));
    ipcMain.handle(IpcChannels.filesListFiles, (_event, root: string) => files.listFiles(root));
    ipcMain.handle(IpcChannels.filesSearch, (_event, root: string, query: string, caseSensitive?: boolean) => files.searchContents(root, query, caseSensitive === true));
    ipcMain.handle(IpcChannels.filesRead, (_event, root: string, file: string) => files.readFile(root, file));
    // Like files.read, info does not need a known worktree. The editor also opens files of other roots.
    ipcMain.handle(IpcChannels.filesInfo, (_event, root: string, file: string) => files.info(String(root), String(file)));
    ipcMain.handle(IpcChannels.filesReveal, async (_event, root: string, file: string) => {
        shell.showItemInFolder(resolveInside(await knownWorktree(root), String(file)));
    });
    ipcMain.handle(IpcChannels.filesOpenInDefaultApp, async (_event, root: string, file: string) => {
        const absolute = resolveInside(await knownWorktree(root), String(file));
        // Only viewable media files open. Thus the page cannot start a program or a script.
        if (!isMediaKind(await detectKind(absolute))) {
            throw new Error(`ShipWarden opens only images, PDF, audio and video files in the default app.`);
        }
        const message = await shell.openPath(absolute);
        if (message) {
            throw new Error(message);
        }
    });
    ipcMain.handle(IpcChannels.filesReadExternal, (_event, absolutePath: string) => files.readExternal(absolutePath));
    ipcMain.handle(IpcChannels.filesWrite, (_event, root: string, file: string, content: string) => files.writeFile(root, file, content));
    ipcMain.on(IpcChannels.filesWatch, (_event, root: string) => fileWatcher.start(root));
    ipcMain.on(IpcChannels.filesUnwatch, (_event, root: string) => fileWatcher.stop(root));

    // Each call goes to the provider of its target: Azure DevOps for a worktree with an Azure Repos remote, else GitHub.
    const host = (target: RepoTarget) => reviewProviders.for(target);
    ipcMain.handle(IpcChannels.githubStatus, (_event, root: string) => reviewProviders.branchStatus(root));
    ipcMain.handle(IpcChannels.githubBranchSummaries, (_event, repoPath: string) => reviewProviders.branchSummaries(repoPath));
    ipcMain.handle(IpcChannels.githubCreatePullRequest, async (_event, root: string, request: NewPullRequest) =>
        (await host(root)).createPullRequest(root, {
            title: String(request?.title ?? '').trim(),
            body: String(request?.body ?? ''),
            base: typeof request?.base === 'string' && request.base ? request.base : undefined,
            draft: request?.draft === true
        }));
    ipcMain.handle(IpcChannels.githubFiles, async (_event, target: RepoTarget, number: number) => (await host(target)).pullRequestFiles(target, number));
    ipcMain.handle(IpcChannels.githubFileVersions, async (_event, target: RepoTarget, file: PullRequestFile, baseSha: string, headSha: string) =>
        (await host(target)).fileVersions(target, file, baseSha, headSha));
    ipcMain.handle(IpcChannels.githubSubmitReview, async (_event, target: RepoTarget, number: number, headSha: string, reviewEvent: ReviewEvent, body: string, comments: PendingComment[]) =>
        (await host(target)).submitReview(target, number, headSha, reviewEvent, body, comments));
    ipcMain.handle(IpcChannels.githubReply, async (_event, target: RepoTarget, number: number, commentId: number, body: string) =>
        (await host(target)).replyToComment(target, number, commentId, body));
    ipcMain.handle(IpcChannels.githubSetThreadResolved, async (_event, target: RepoTarget, threadId: string, resolved: boolean) =>
        (await host(target)).setThreadResolved(threadId, resolved));
    ipcMain.handle(IpcChannels.githubMerge, async (_event, target: RepoTarget, number: number, headSha: string, method: MergeMethod) =>
        (await host(target)).merge(target, number, headSha, method));
    ipcMain.handle(IpcChannels.githubChecks, async (_event, target: RepoTarget, sha: string) => (await host(target)).checks(target, sha));
    ipcMain.handle(IpcChannels.githubJobProgress, async (_event, target: RepoTarget, jobId: number) => (await host(target)).jobProgress(target, Number(jobId)));
    ipcMain.handle(IpcChannels.githubJobLog, async (_event, target: RepoTarget, jobId: number) => (await host(target)).jobLog(target, jobId));
    ipcMain.handle(IpcChannels.githubSaveJobLog, async (_event, target: RepoTarget, jobId: number) => (await host(target)).saveJobLog(target, jobId));
    ipcMain.handle(IpcChannels.githubRerunJob, async (_event, target: RepoTarget, jobId: number) => (await host(target)).rerunJob(target, jobId));
    ipcMain.handle(IpcChannels.githubRerunFailedJobs, async (_event, target: RepoTarget, runId: number) => (await host(target)).rerunFailedJobs(target, runId));
    ipcMain.handle(IpcChannels.githubWorkflows, async (_event, target: RepoTarget, ref: string) => (await host(target)).workflows(target, ref));
    ipcMain.handle(IpcChannels.githubDispatchWorkflow, async (_event, target: RepoTarget, workflowId: number, ref: string, inputs?: Record<string, string>) =>
        (await host(target)).dispatchWorkflow(target, workflowId, ref, inputs && typeof inputs === 'object' ? inputs : undefined));
    ipcMain.handle(IpcChannels.githubWorkflowRuns, async (_event, target: RepoTarget, workflowId?: number) =>
        (await host(target)).workflowRuns(target, typeof workflowId === 'number' ? workflowId : undefined));
    ipcMain.handle(IpcChannels.githubRunJobs, async (_event, target: RepoTarget, runId: number) => (await host(target)).runJobs(target, Number(runId)));
    ipcMain.handle(IpcChannels.githubCancelRun, async (_event, target: RepoTarget, runId: number) => (await host(target)).cancelRun(target, Number(runId)));
    ipcMain.handle(IpcChannels.githubRerunRun, async (_event, target: RepoTarget, runId: number) => (await host(target)).rerunRun(target, Number(runId)));
    ipcMain.handle(IpcChannels.githubBranches, async (_event, target: RepoTarget) => (await host(target)).branches(target));
    ipcMain.handle(IpcChannels.githubPullRequest, async (_event, target: RepoTarget, number: number) => (await host(target)).pullRequest(target, number));
    ipcMain.handle(IpcChannels.githubSetFileViewed, async (_event, target: RepoTarget, pullRequestId: string, path: string, viewed: boolean) =>
        (await host(target)).setFileViewed(pullRequestId, path, viewed));
    ipcMain.handle(IpcChannels.githubPullRequestCandidates, async (_event, target: RepoTarget) => (await host(target)).pullRequestCandidates(target));
    ipcMain.handle(IpcChannels.githubChangePullRequest, async (_event, target: RepoTarget, number: number, change: PullRequestChange) =>
        (await host(target)).changePullRequest(target, number, change));
    ipcMain.handle(IpcChannels.reviewProvidersList, () => reviewProviders.list());
    ipcMain.handle(IpcChannels.reviewProvidersAdd, (_event, kind: ReviewProviderKind, name: string) => reviewProviders.add(kind, String(name ?? '')));
    ipcMain.handle(IpcChannels.reviewProvidersUpdate, (_event, id: string, change: ReviewProviderChange) => reviewProviders.update(String(id), change ?? {}));
    ipcMain.handle(IpcChannels.reviewProvidersRemove, (_event, id: string) => reviewProviders.remove(String(id)));
    ipcMain.handle(IpcChannels.reviewProvidersSaveToken, (_event, id: string, token: string) => reviewProviders.saveToken(String(id), token));
    ipcMain.handle(IpcChannels.reviewProvidersClearToken, (_event, id: string) => reviewProviders.clearToken(String(id)));
    ipcMain.handle(IpcChannels.reviewProvidersTokenSource, (_event, id: string) => reviewProviders.tokenSource(String(id)));
    ipcMain.handle(IpcChannels.reviewProvidersTest, (_event, id: string, organization?: string) =>
        reviewProviders.test(String(id), typeof organization === 'string' ? organization : undefined));
    ipcMain.handle(IpcChannels.reviewProvidersGitHubOwners, (_event, id: string) => reviewProviders.githubOwners(String(id)));
    ipcMain.handle(IpcChannels.githubRepositories, () => reviewProviders.repositories());
    ipcMain.handle(IpcChannels.githubRepoOf, (_event, root: string) => reviewProviders.githubRepoFor(String(root)).catch(() => null));
    ipcMain.handle(IpcChannels.githubDashboardPullRequests, () => reviewProviders.dashboardPullRequests());
    ipcMain.handle(IpcChannels.githubDashboardComments, () => reviewProviders.dashboardComments());
    ipcMain.handle(IpcChannels.seenKeys, () => seen.keys());
    ipcMain.handle(IpcChannels.seenMark, (_event, keys: unknown) => seen.mark(Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : []));
    ipcMain.handle(IpcChannels.githubPullRequests, async (_event, repo: RepoRef, filter: PullRequestFilter, query?: string) =>
        (await reviewProviders.github(repo)).pullRequests({ owner: String(repo?.owner), name: String(repo?.name) }, filter, query));
    ipcMain.on(IpcChannels.browserCreate, (_event, id: string, url: string) => browserViews.create(String(id), String(url)));
    ipcMain.on(IpcChannels.browserSetBounds, (_event, id: string, bounds: BrowserBounds | null) => browserViews.setBounds(String(id), validBounds(bounds)));
    ipcMain.on(IpcChannels.browserLoad, (_event, id: string, url: string) => browserViews.load(String(id), String(url)));
    ipcMain.on(IpcChannels.browserBack, (_event, id: string) => browserViews.back(String(id)));
    ipcMain.on(IpcChannels.browserForward, (_event, id: string) => browserViews.forward(String(id)));
    ipcMain.on(IpcChannels.browserReload, (_event, id: string) => browserViews.reload(String(id)));
    ipcMain.on(IpcChannels.browserStop, (_event, id: string) => browserViews.stop(String(id)));
    ipcMain.on(IpcChannels.browserFocus, (_event, id: string) => browserViews.focus(String(id)));
    ipcMain.on(IpcChannels.browserDestroy, (_event, id: string) => browserViews.destroy(String(id)));
    ipcMain.handle(IpcChannels.browserState, (_event, id: string) => browserViews.state(String(id)));
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
    ipcMain.on(IpcChannels.lspRespond, (_event, id: number, result: unknown) => lsp.respond(id, result));

    ipcMain.handle(IpcChannels.terminalsSettings, () => loadGhosttySettings());
    ipcMain.handle(IpcChannels.terminalsList, terminalSessions);
    ipcMain.handle(IpcChannels.terminalsCreate, async (_event, options: CreateTerminalOptions) => {
        const command = options.isAgent && options.command ? withAgentHooks(options.command, hookSettingsPaths) : options.command;
        // Only an agent that got the hooks reports its state.
        const env = { ...process.env, ...shellIntegrationEnv(process.env, shellIntegration) };
        const session = await terminals.create({ ...options, command, reportsAgentState: !!options.isAgent && command !== options.command }, env);
        void shellAgents.poll();
        terminalSizes.set(session.id, { cols: options.cols, rows: options.rows });
        remote.agentsChanged();
        return session;
    });
    ipcMain.handle(IpcChannels.appInfo, () => ({ version: app.getVersion(), dataFolder: app.getPath('userData'), ptyHostLog }));
    ipcMain.handle(IpcChannels.usageGet, () => usage.get());
    ipcMain.handle(IpcChannels.usageRefresh, () => usage.refresh(true));
    ipcMain.handle(IpcChannels.askRun, (_event, request: AskAgentRequest) => askAgent(request));
    ipcMain.handle(IpcChannels.askCancel, (_event, id: string) => askRunner.cancel(String(id)));
    ipcMain.handle(IpcChannels.askAnswers, (_event, repo: RepoRef, number: number) =>
        answers.list({ owner: String(repo?.owner ?? ''), name: String(repo?.name ?? '') }, Number(number)));
    ipcMain.handle(IpcChannels.askSaveAnswer, (_event, answer: unknown) => answers.save(answer));
    ipcMain.handle(IpcChannels.askCodeAnswers, (_event, worktree: string, path: string) => codeAnswers.list(String(worktree), String(path)));
    ipcMain.handle(IpcChannels.askSaveCodeAnswer, (_event, answer: unknown) => codeAnswers.save(answer));
    ipcMain.handle(IpcChannels.askRemoveCodeAnswer, (_event, id: string) => codeAnswers.remove(String(id)));
    ipcMain.handle(IpcChannels.askRemoveAnswer, (_event, id: string) => answers.remove(String(id)));
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
        if (JSON.stringify(before.remote) !== JSON.stringify(next.remote)) {
            await remote.apply(next.remote);
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
        const targets = [
            { name: 'GitHub', url: 'https://api.github.com/' },
            { name: 'ClickUp', url: 'https://api.clickup.com/' },
            { name: 'Azure DevOps', url: 'https://dev.azure.com/' }
        ];
        return Promise.all(targets.map(async host => {
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
    ipcMain.handle(IpcChannels.remoteStatus, () => remote.status());
    ipcMain.handle(IpcChannels.remoteStartPairing, () => remote.startPairing());
    ipcMain.handle(IpcChannels.remoteCancelPairing, () => remote.cancelPairing());
    ipcMain.handle(IpcChannels.remoteRemoveDevice, (_event, id: string) => remote.removeDevice(String(id)));
    ipcMain.handle(IpcChannels.settingsCheckCommand, (_event, command: string) => checkCommand(String(command)));
    ipcMain.on(IpcChannels.appFocus, () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            app.focus({ steal: true });
        }
    });
    ipcMain.handle(IpcChannels.terminalsReplay, (_event, id: string) => terminals.replay(id));
    const pathList = (paths: unknown) => (Array.isArray(paths) ? paths.map(String) : []);
    ipcMain.handle(IpcChannels.gitChanges, async (_event, worktree: string) => gitChanges.status(await knownWorktree(worktree)));
    ipcMain.handle(IpcChannels.gitStage, async (_event, worktree: string, paths: unknown) => gitChanges.stage(await knownWorktree(worktree), pathList(paths)));
    ipcMain.handle(IpcChannels.gitUnstage, async (_event, worktree: string, paths: unknown) => gitChanges.unstage(await knownWorktree(worktree), pathList(paths)));
    ipcMain.handle(IpcChannels.gitContents, async (_event, worktree: string, path: string, side: string, oldPath?: string) =>
        gitChanges.contents(await knownWorktree(worktree), String(path), side === 'staged' ? 'staged' : 'unstaged', typeof oldPath === 'string' ? oldPath : undefined));
    ipcMain.handle(IpcChannels.gitCommit, async (_event, worktree: string, message: string, amend: boolean) =>
        gitChanges.commit(await knownWorktree(worktree), String(message), amend === true));
    ipcMain.handle(IpcChannels.gitLastMessage, async (_event, worktree: string) => gitChanges.lastMessage(await knownWorktree(worktree)));
    ipcMain.handle(IpcChannels.gitDiscard, async (_event, worktree: string, paths: unknown) => gitChanges.discard(await knownWorktree(worktree), pathList(paths)));
    // A background fetch at most every 5 minutes for each repository. "force" (the Refresh button) fetches at once.
    ipcMain.handle(IpcChannels.gitFetch, async (_event, worktree: string, force?: boolean) =>
        gitChanges.fetch(await knownWorktree(worktree), force === true ? 0 : 5 * 60 * 1000));
    ipcMain.handle(IpcChannels.gitLog, async (_event, worktree: string, scope: unknown, limit: unknown) =>
        gitChanges.log(await knownWorktree(worktree), scope === 'local' ? 'local' : 'all', typeof limit === 'number' && Number.isFinite(limit) ? limit : 300));
    ipcMain.handle(IpcChannels.gitPull, async (_event, worktree: string) => gitChanges.pull(await knownWorktree(worktree)));
    ipcMain.handle(IpcChannels.gitPush, async (_event, worktree: string) => gitChanges.push(await knownWorktree(worktree)));
    ipcMain.handle(IpcChannels.updatesState, () => updates.getState());
    ipcMain.handle(IpcChannels.updatesCheck, () => updates.check());
    ipcMain.handle(IpcChannels.updatesInstall, () => updates.install());
    ipcMain.on(IpcChannels.appRunKey, (_event, action: unknown) => {
        if (action === 'quit' || action === 'quitAndStop' || action === 'settings' || action === 'hide') runAppKey(action);
    });
    ipcMain.on(IpcChannels.appConfirmAnswer, (_event, id: number, confirmed: boolean) => confirmAnswers.get(Number(id))?.(confirmed === true));
    ipcMain.handle(IpcChannels.terminalsKill, (_event, id: string) => killTerminal(String(id)));
    ipcMain.handle(IpcChannels.terminalsStopOutdated, async () => {
        const stopped = await terminals.shutdownOutdatedHosts();
        remote.agentsChanged();
        return stopped;
    });
    ipcMain.handle(IpcChannels.processesList, (_event, worktreePaths: unknown) =>
        processes.scan(Array.isArray(worktreePaths) ? worktreePaths.filter((item): item is string => typeof item === 'string') : []));
    ipcMain.handle(IpcChannels.processesStop, (_event, worktreePath: string, pid: number) => processes.stop(String(worktreePath), Number(pid)));
    ipcMain.on(IpcChannels.terminalsWrite, (_event, id: string, data: string) => terminals.write(id, data));
    ipcMain.on(IpcChannels.terminalsResize, (_event, id: string, cols: number, rows: number) => {
        terminals.resize(id, cols, rows);
        if (cols > 0 && rows > 0) {
            terminalSizes.set(id, { cols, rows });
            remote.terminalResized(id, cols, rows);
        }
    });
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

/** Returns the bounds when all four values are finite numbers. Else returns null, which hides the view. */
function validBounds(bounds: unknown): BrowserBounds | null {
    if (!bounds || typeof bounds !== 'object') return null;
    const { x, y, width, height } = bounds as Record<string, unknown>;
    const values = [x, y, width, height];
    return values.every(value => typeof value === 'number' && Number.isFinite(value))
        ? { x: x as number, y: y as number, width: width as number, height: height as number }
        : null;
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
    if (input.type !== 'keyDown' || !input.meta || input.control) return false;
    const key = input.code?.startsWith('Key') ? input.code.slice(3).toLowerCase() : input.key.toLowerCase();
    if (key === 'r' && !input.shift && !input.alt) {
        browserViews.reload(id);
        return true;
    }
    if (key === 'l' && !input.shift && !input.alt) {
        mainWindow?.webContents.focus();
        mainWindow?.webContents.send(IpcChannels.browserFocusAddress, id);
        return true;
    }
    if (key === 'i' && input.alt && !input.shift) {
        browserViews.toggleDevTools(id);
        return true;
    }
    return false;
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
                { label: 'New Worktree…', accelerator: 'Command+N', click: () => sendShortcut('newWorktree') },
                { label: 'New Shell Tab', accelerator: 'Command+T', click: () => sendShortcut('newTab') },
                { label: 'Split Right', accelerator: 'Command+D', click: () => sendShortcut('right') },
                { label: 'Split Down', accelerator: 'Shift+Command+D', click: () => sendShortcut('down') },
                { type: 'separator' },
                { label: 'Select Split Left', accelerator: 'Alt+Command+Left', click: () => sendShortcut('focusLeft') },
                { label: 'Select Split Right', accelerator: 'Alt+Command+Right', click: () => sendShortcut('focusRight') },
                { label: 'Select Split Above', accelerator: 'Alt+Command+Up', click: () => sendShortcut('focusUp') },
                { label: 'Select Split Below', accelerator: 'Alt+Command+Down', click: () => sendShortcut('focusDown') },
                { type: 'separator' },
                { label: 'Close Pane', accelerator: 'Command+W', click: () => sendShortcut('close') },
                { role: 'close', label: 'Close Window', accelerator: 'Shift+Command+W' }
            ]
        },
        { role: 'editMenu' },
        {
            label: 'View',
            submenu: [
                { label: 'Toggle Sidebar', accelerator: 'Command+B', click: () => sendShortcut('toggleSidebar') },
                { label: 'Focus Sidebar', accelerator: 'Shift+Command+B', click: () => sendShortcut('focusSidebar') },
                { label: 'Toggle Right Panel', accelerator: 'Command+E', click: () => sendShortcut('toggleRightPanel') },
                { label: 'Focus File Explorer', accelerator: 'Shift+Command+E', click: () => sendShortcut('focusExplorer') },
                // ⌘0 stays the key of Actual Size, so this item uses ⇧⌘0.
                { label: 'Focus Workspace', accelerator: 'Shift+Command+0', click: () => sendShortcut('focusWorkspace') },
                { type: 'separator' },
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        {
            label: 'Go',
            submenu: [
                { label: 'Back', accelerator: 'Command+[', click: () => sendShortcut('back') },
                { label: 'Forward', accelerator: 'Command+]', click: () => sendShortcut('forward') },
                { type: 'separator' },
                { label: 'Dashboard', accelerator: 'Alt+Command+1', click: () => sendShortcut('viewDashboard') },
                { label: 'Agents', accelerator: 'Alt+Command+2', click: () => sendShortcut('viewAgents') },
                { label: 'Tasks', accelerator: 'Alt+Command+3', click: () => sendShortcut('viewTasks') },
                { label: 'Review', accelerator: 'Alt+Command+4', click: () => sendShortcut('viewReview') },
                { label: 'Pipelines', accelerator: 'Alt+Command+5', click: () => sendShortcut('viewPipelines') },
                { label: 'Notes', accelerator: 'Alt+Command+6', click: () => sendShortcut('viewNotes') },
                { type: 'separator' },
                // ⌃⇧Tab and ⌃Tab also select the previous and the next tab.
                { label: 'Select Previous Tab', accelerator: 'Shift+Command+[', click: () => sendShortcut('previousTab') },
                { label: 'Select Next Tab', accelerator: 'Shift+Command+]', click: () => sendShortcut('nextTab') },
                {
                    label: 'Select Tab',
                    submenu: [
                        ...([1, 2, 3, 4, 5, 6, 7, 8] as const).map(digit => ({
                            label: `Tab ${digit}`,
                            accelerator: `Command+${digit}`,
                            click: () => sendShortcut(`selectTab${digit}`)
                        })),
                        { label: 'Last Tab', accelerator: 'Command+9', click: () => sendShortcut('selectLastTab') }
                    ]
                }
            ]
        },
        { role: 'windowMenu' }
    ]));
}

app.whenReady().then(async () => {
    await projects.load();
    applyNativeAppearance((await settings.get()).appearance);
    buildMenu();
    try {
        writeFileSync(hookSettingsPaths.claude, JSON.stringify(claudeHookSettings(), null, 2));
    } catch (error) {
        // Without the hook settings, agents still run. ShipWarden then shows no agent state.
        console.warn(`[agents] The hook settings were not written: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
        writeGeminiHookSettings(hookSettingsPaths.gemini);
    } catch (error) {
        // Without the hook settings, Gemini CLI still runs. ShipWarden then shows no state for it.
        console.warn(`[agents] The Gemini CLI hook settings were not written: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
        writeOpencodePlugin(hookSettingsPaths.opencode);
        shellIntegration.opencodeConfigContent = opencodeHookConfig(hookSettingsPaths.opencode);
    } catch (error) {
        // Without the plugin, opencode still runs. ShipWarden then shows no state for it.
        console.warn(`[agents] The opencode plugin was not written: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
        shellIntegration.zshFolder = writeZshIntegration(join(app.getPath('userData'), 'shell-integration', 'zsh'));
    } catch (error) {
        // Without the zsh folder, shells start as usual. A `claude` that the user types then shows no agent state.
        console.warn(`[agents] The zsh integration was not written: ${error instanceof Error ? error.message : String(error)}`);
    }
    shellAgents.start();
    protocol.handle(FILE_SCHEME, createFileProtocolHandler(knownWorktree));
    registerIpc();
    createWindow();
    void settings.get().then(all => remote.apply(all.remote)).catch(error => console.error('[remote] The phone server did not start:', error));
    // The usage requests need the extra certificates on a network that inspects TLS traffic.
    void networkReady.then(() => usage.start());
    // The packaged app looks for updates. In development, the user can still check in Settings › About.
    if (app.isPackaged) void networkReady.then(() => updates.start());
    // Remove the copies of pull requests that the user did not open for some days.
    void shellReady.then(() => reviewCheckouts.prune()).catch(error => console.warn('[review] The old pull request copies were not removed:', error));

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
    void remote.stop();
    usage.stop();
    updates.stop();
    notes.close();
    fileWatcher.dispose();
    lsp.stopAll();
    tasks.stopAll();
    askRunner.cancelAll();
});
