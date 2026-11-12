import { join } from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { app, shell } from 'electron';
import { IpcChannels } from '@shared/api';
import type { ShellIntegration } from './agents/shell-integration';
import { ShellAgents } from './agents/shell-agents';
import { AskAgentRunner } from './agents/ask-agent';
import { hookSettingsPaths } from './agents/hook-files';
import type { MainWindow } from './app/main-window';
import { ConfirmDialogs } from './app/confirm';
import { FileService } from './files/file-service';
import { FileWatcher } from './files/file-watcher';
import { LspManager } from './lsp/lsp-manager';
import { setManagedFolder } from './lsp/servers';
import { ServerInstaller } from './lsp/server-install';
import { PluginSettings } from './tasks/plugin-settings';
import { TaskHost } from './tasks/task-host';
import { ProjectStore } from './project-store';
import { loadLoginShellPath, loginShellCaFile } from './shell-env';
import { TrustedCertificates } from './network/trusted-certificates';
import { NotesService } from './notes/notes-service';
import { AutomationStore } from './automations/automation-store';
import { PlanStore } from './plans/plan-store';
import { PrGroupStore } from './pr-groups/pr-group-store';
import { LEGACY_NAMES } from './legacy-migration';
import { NotificationService } from './notifications';
import { buildSocketPath, ptyHostSocketFolder, ptyHostSocketPath } from './pty-host/protocol';
import { hostBuildId, PtyHostClient } from './pty-host/pty-host-client';
import { ProcessService } from './processes/process-service';
import { StaleShellCloser } from './terminal/stale-shells';
import { bundlePathOf, UpdateService } from './updates/update-service';
import { GitChangesService } from './git/git-changes-service';
import { GitWorktreeService } from './worktrees/git-worktree-service';
import { ProjectWorktrees } from './worktrees/project-worktrees';
import { SettingsStore } from './settings-store';
import { SeenStore } from './seen-store';
import { AnswersStore, CodeAnswersStore } from './answers-store';
import { ReviewCheckouts } from './review/review-checkouts';
import { ReviewProviders } from './review-providers';
import { UsageService } from './usage/usage-service';
import { RemoteDevices } from './remote/remote-devices';
import { localHosts, RemoteServer } from './remote/remote-server';
import { RemoteSnapshotBuilder } from './remote/remote-snapshot';
import { ensureTlsIdentity } from './remote/tls-identity';
import { connectHelper } from './helper/helper-link';
import { helperPlist, LaunchAgent } from './helper/launch-agent';
import { HELPER_LABEL, helperSocketPath } from './helper/protocol';
import { RemoteControl } from './helper/remote-control';
import { BrowserViews } from './browser/browser-views';
import { checkCommand } from './command-check';
import { SetupChecks } from './setup-checks';

/** The parts of the app that the services need. */
export interface ServiceOptions {
    window: MainWindow;
    /** The folder of the built main process. The PTY host script is in this folder. */
    mainFolder: string;
    /** Handles a key of a browser view. Returns true when the app used the key. */
    onBrowserInput(id: string, input: Electron.Input): boolean;
    /**
     * True when `SHIPWARDEN_USER_DATA_DIR` selects a separate app data folder. The app then does not connect to the PTY
     * hosts of the old app name, so a test of a first start does not show the real terminals.
     */
    separateDataFolder?: boolean;
}

/** The services of the main process. `createServices` makes them. */
export type Services = ReturnType<typeof createServices>;

/**
 * Makes the services of the main process and connects them. Call it one time, before the app is ready.
 * Some services call other services in callbacks. The callbacks run after this function returns.
 */
export function createServices({ window, mainFolder, onBrowserInput, separateDataFolder = false }: ServiceOptions) {
    const userData = app.getPath('userData');
    const worktrees = new GitWorktreeService();
    const projects = new ProjectStore(join(userData, 'projects.json'), join(userData, 'state.json'));
    const files = new FileService(file => shell.trashItem(file));

    const fileWatcher = new FileWatcher(event => window.send(IpcChannels.filesChanged, event));
    // Language servers need the PATH of the login shell. Load it in the background.
    const shellReady = loadLoginShellPath();
    const certificates = new TrustedCertificates(join(userData, 'trusted-ca.pem'));
    /**
     * The extra CA certificates apply before the first network request. The settings store comes later in this function,
     * but this callback runs after the function returns.
     */
    const networkReady: Promise<void> = shellReady
        .then(async () => {
            await certificates.apply((await settings.get()).network, loginShellCaFile());
        })
        .catch(error => console.warn(`[network] The trusted certificates were not applied: ${error instanceof Error ? error.message : String(error)}`));
    /** The language servers that ShipWarden installs go here. The LSP launcher looks here before it looks in the PATH. */
    const languageServersFolder = join(userData, 'language-servers');
    setManagedFolder(languageServersFolder);
    const serverInstaller = new ServerInstaller({
        folder: languageServersFolder,
        // The downloads need the extra certificates of Settings › Network on a network that inspects TLS traffic.
        ready: networkReady,
        extraCertificateBundle: () => certificates.status().bundlePath,
        onState: state => window.send(IpcChannels.lspInstallState, state)
    });
    const lsp = new LspManager(message => window.send(IpcChannels.lspMessage, message), shellReady, serverInstaller);
    /** The in-app browser. Each browser tab of the page has a WebContentsView in the main window. */
    const browserViews = new BrowserViews(
        () => window.get(),
        () => certificates.extraCertificates(),
        {
            onState: state => window.send(IpcChannels.browserStateChanged, state),
            onOpenTab: (url, openerId) => window.send(IpcChannels.browserOpenTab, url, openerId),
            onFocus: id => window.send(IpcChannels.browserFocused, id),
            onInput: (id, input) => onBrowserInput(id, input)
        }
    );
    /**
     * The code review providers (GitHub and Azure DevOps accounts). Each pull request and pipeline call goes to the provider
     * of its target. The clients use the same trusted certificates as the in-app browser (`networkReady`).
     */
    const reviewProviders = new ReviewProviders({
        file: join(userData, 'review-providers.json'),
        // The file of the old Azure DevOps token, so that the migration of an older version keeps the token.
        secretsFile: join(userData, 'source-host-secrets.json'),
        ready: networkReady,
        legacyReviewOwners: async () => (await settings.get()).reviewOwners,
        onChanged: () => window.send(IpcChannels.reviewProvidersChanged),
        projectRepos: async () => (await projects.get()).projects.flatMap(project => project.repos)
    });

    const tasks = new TaskHost({
        pluginFolders: [
            // The packaged app keeps the built-in plugins outside the asar archive, because a process cannot start in an archive folder.
            { path: app.isPackaged ? join(process.resourcesPath, 'plugins') : join(app.getAppPath(), 'plugins'), builtIn: true },
            { path: join(os.homedir(), '.shipwarden', 'plugins'), builtIn: false }
        ],
        settings: new PluginSettings(join(userData, 'plugin-settings.json')),
        repoFor: root => reviewProviders.githubRepoFor(root),
        allRepos: async () => (await projects.get()).projects.flatMap(project => project.repos),
        configFile: join(userData, 'task-managers.json'),
        legacySourcesFile: join(userData, 'task-sources.json'),
        linksFile: join(userData, 'task-links.json'),
        collectionsFile: join(userData, 'task-collections.json'),
        selectedConnectionsFile: join(userData, 'task-selected-connections.json'),
        onChanged: connectionId => window.send(IpcChannels.tasksChanged, connectionId),
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
    const ptyHostScript = join(mainFolder, 'pty-host.js');
    const terminals = new PtyHostClient({
        // Each build has its own host. A host of an older build keeps its sessions, and new sessions use this build.
        socketPath: buildSocketPath(ptyHostSocketFolder(userData), hostBuildId(ptyHostScript)),
        olderSocketPaths: [
            ptyHostSocketPath(userData),
            ...(separateDataFolder ? [] : LEGACY_NAMES.map(name => ptyHostSocketPath(join(app.getPath('appData'), name))))
        ],
        hostScript: ptyHostScript,
        logPath: join(userData, 'pty-host.log'),
        events: {
            data: (id, data, seq) => {
                window.send(IpcChannels.terminalsData, id, data, seq);
                remote.terminalData(id, data, seq);
            },
            exit: (id, exitCode) => {
                shellAgents.forget(id);
                window.send(IpcChannels.terminalsExit, id, exitCode);
                remote.terminalExited(id);
            },
            agentState: (id, update) => {
                window.send(IpcChannels.terminalsAgentState, id, update);
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
        onState: state => window.send(IpcChannels.updatesChanged, state),
        quit: () => app.quit()
    });

    /** The local git changes of the worktrees: status, stage, commit and push. */
    const gitChanges = new GitChangesService(file => shell.trashItem(file));

    /** The processes and ports of the worktrees. */
    const processes = new ProcessService({ sessions: () => terminals.list(), hostPids: () => terminals.hostPids() });

    /** Finds the agents that the user starts in a shell tab, for example with `claude` or `codex`. */
    const shellAgents = new ShellAgents({
        sessions: () => (terminals.isConnected() ? terminals.list() : Promise.resolve([])),
        hostPids: () => terminals.hostPids(),
        processTable: () => processes.table(),
        onState: (id, update) => {
            window.send(IpcChannels.terminalsAgentState, id, update);
            remote.agentsChanged();
        },
        onProgram: (id, program) => {
            window.send(IpcChannels.terminalsAgentProgram, id, program ?? null);
            remote.agentsChanged();
        }
    });

    /** The sessions of the PTY host, with the agents that the app found in shell tabs. */
    const terminalSessions = async () => shellAgents.annotate(await terminals.list());

    /** The plan usage of Claude Code and Codex for the status bar. */
    const usage = new UsageService(`ShipWarden/${app.getVersion()}`, list => window.send(IpcChannels.usageChanged, list));
    const settings = new SettingsStore(join(userData, 'settings.json'));
    const seen = new SeenStore(join(userData, 'seen.json'));
    const answers = new AnswersStore(join(userData, 'agent-answers.json'));
    /** The local copies of pull requests for go to definition and the file explorer in the Review view. */
    const reviewCheckouts = new ReviewCheckouts({
        folder: join(os.homedir(), '.shipwarden', 'review'),
        indexFile: join(userData, 'review-checkouts.json'),
        findClone: repo => projectWorktrees.localClone(repo)
    });
    const codeAnswers = new CodeAnswersStore(join(userData, 'agent-code-answers.json'));
    /** A click on a notification brings the window to the front and tells the page where to go. */
    const notifications = new NotificationService(target => {
        const current = window.get();
        if (current) {
            if (current.isMinimized()) current.restore();
            current.show();
            current.focus();
            current.webContents.send(IpcChannels.notificationsClicked, target);
        }
    });
    /** The notes are in the home folder, not the app data folder, so the user and agents can find and open them. */
    const notes = new NotesService(join(os.homedir(), '.shipwarden', 'notes'), file => shell.trashItem(file));
    /** The automations are in the home folder too, so the user can read, change and share the files. The runs are local. */
    const automations = new AutomationStore(join(os.homedir(), '.shipwarden', 'automations'), join(userData, 'automation-runs.json'), file =>
        shell.trashItem(file)
    );
    const ptyHostLog = join(userData, 'pty-host.log');

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

    /** Approves a pull request for the phone. The worktree must be a worktree of a project. */
    async function approveForPhone(worktreePath: string, number: number, headSha: string, body: string): Promise<void> {
        const worktree = await projectWorktrees.check(worktreePath);
        await (await reviewProviders.for(worktree)).submitReview(worktree, number, headSha, 'APPROVE', body, []);
        remoteSnapshot.invalidate();
    }

    const notifyRemoteChanged = () => window.send(IpcChannels.remoteChanged);

    /** The HTTPS server for the phone app in this process. Each call makes a new server, which reads the paired phones again. */
    const createLocalRemote = () =>
        new RemoteServer({
            devices: new RemoteDevices(join(userData, 'remote-devices.json')),
            identity: () => ensureTlsIdentity(userData),
            hosts: () => localHosts(localHostName),
            backend: {
                macName: () => computerName,
                version: app.getVersion(),
                snapshot: () => remoteSnapshot.build(),
                // The size from the page is newer than the size of an older PTY host, which has none.
                sessions: async () => (await terminalSessions()).map(session => ({ ...session, ...terminalSizes.get(session.id) })),
                replay: id => terminals.replay(id),
                write: (id, data) => terminals.write(id, data),
                approvePullRequest: approveForPhone,
                onStatusChanged: notifyRemoteChanged
            }
        });

    /**
     * The background helper runs the phone server while the app is closed (Settings › Mobile). A launch agent starts it.
     * It is a second program in this build, like the PTY host.
     */
    const helperScript = join(mainFolder, 'helper.js');
    const helperLaunchAgent = new LaunchAgent(HELPER_LABEL);

    /**
     * The phone server runs only while Settings › Mobile has it on. It runs in the background helper when that setting
     * is on and the helper answers. Else it runs in this process.
     */
    const remote = new RemoteControl({
        createLocal: createLocalRemote,
        connectHelper: () =>
            connectHelper(helperSocketPath(userData), {
                snapshot: () => remoteSnapshot.build(),
                approvePullRequest: ({ worktreePath, number, headSha, body }) =>
                    approveForPhone(String(worktreePath), Number(number), String(headSha), String(body ?? '')),
                statusChanged: notifyRemoteChanged
            }),
        agent: {
            install: () =>
                helperLaunchAgent.install(
                    helperPlist({
                        label: HELPER_LABEL,
                        execPath: process.execPath,
                        helperScript,
                        userData,
                        version: app.getVersion(),
                        logPath: join(userData, 'helper.log'),
                        shell: process.env.SHELL
                    })
                ),
            remove: () => helperLaunchAgent.remove(),
            restart: () => helperLaunchAgent.restart()
        },
        helperBuildId: hostBuildId(helperScript),
        onStatusChanged: notifyRemoteChanged
    });

    /** The worktrees and the repositories of the projects. */
    const projectWorktrees = new ProjectWorktrees({
        projectRepos: async () => (await projects.get()).projects.flatMap(project => project.repos),
        worktreePaths: async repo => (await worktrees.list(repo)).map(item => item.path),
        isReviewCheckout: path => reviewCheckouts.has(path),
        repoFor: root => reviewProviders.repoFor(root)
    });

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

    /** Closes the shell tabs with no input and no output for 7 days (Settings › Worktrees). */
    const staleShells = new StaleShellCloser({
        enabled: async () => (await settings.get()).worktrees.closeStaleShells,
        sessions: () => (terminals.isConnected() ? terminalSessions() : Promise.resolve([])),
        processTable: () => processes.table(),
        close: killTerminal
    });

    /** The setup checks of the welcome page and the checklist. They reuse the PATH check and the token order of the app. */
    const setupChecks = new SetupChecks({
        checkCommand: command => checkCommand(command, shellReady),
        settings: () => settings.get(),
        activeRepoCount: async () => {
            const state = await projects.get();
            return state.projects.find(project => project.id === state.activeId)?.repos.length ?? 0;
        },
        githubTokenSource: () => reviewProviders.githubTokenSource()
    });

    const askRunner = new AskAgentRunner();
    const plans = new PlanStore(join(userData, 'plans.json'));
    const prGroups = new PrGroupStore(join(userData, 'pr-groups.json'));
    const confirm = new ConfirmDialogs(() => window.get());
    const hookPaths = hookSettingsPaths(userData);
    /** The shell setup that adds the hook settings to a `claude`, `gemini` or `opencode` that the user types in a shell tab. */
    const shellIntegration: ShellIntegration = { hookSettingsPath: hookPaths.claude, geminiHookSettingsPath: hookPaths.gemini };

    return {
        window,
        worktrees,
        projects,
        files,
        fileWatcher,
        shellReady,
        networkReady,
        lsp,
        serverInstaller,
        certificates,
        browserViews,
        reviewProviders,
        tasks,
        terminals,
        updates,
        gitChanges,
        processes,
        shellAgents,
        terminalSessions,
        killTerminal,
        staleShells,
        usage,
        settings,
        seen,
        answers,
        reviewCheckouts,
        codeAnswers,
        notifications,
        notes,
        automations,
        ptyHostLog,
        terminalSizes,
        remote,
        projectWorktrees,
        askRunner,
        plans,
        prGroups,
        confirm,
        hookPaths,
        shellIntegration,
        setupChecks
    };
}
