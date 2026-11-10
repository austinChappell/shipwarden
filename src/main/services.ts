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
import { PluginSettings } from './tasks/plugin-settings';
import { TaskHost } from './tasks/task-host';
import { ProjectStore } from './project-store';
import { loadLoginShellPath, loginShellCaFile } from './shell-env';
import { TrustedCertificates } from './network/trusted-certificates';
import { NotesService } from './notes/notes-service';
import { LEGACY_NAMES } from './legacy-migration';
import { NotificationService } from './notifications';
import { buildSocketPath, ptyHostSocketFolder, ptyHostSocketPath } from './pty-host/protocol';
import { hostBuildId, PtyHostClient } from './pty-host/pty-host-client';
import { ProcessService } from './processes/process-service';
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
import { BrowserViews } from './browser/browser-views';

/** The parts of the app that the services need. */
export interface ServiceOptions {
    window: MainWindow;
    /** The folder of the built main process. The PTY host script is in this folder. */
    mainFolder: string;
    /** Handles a key of a browser view. Returns true when the app used the key. */
    onBrowserInput(id: string, input: Electron.Input): boolean;
}

/** The services of the main process. `createServices` makes them. */
export type Services = ReturnType<typeof createServices>;

/**
 * Makes the services of the main process and connects them. Call it one time, before the app is ready.
 * Some services call other services in callbacks. The callbacks run after this function returns.
 */
export function createServices({ window, mainFolder, onBrowserInput }: ServiceOptions) {
    const userData = app.getPath('userData');
    const worktrees = new GitWorktreeService();
    const projects = new ProjectStore(join(userData, 'projects.json'), join(userData, 'state.json'));
    const files = new FileService();

    const fileWatcher = new FileWatcher(event => window.send(IpcChannels.filesChanged, event));
    // Language servers need the PATH of the login shell. Load it in the background.
    const shellReady = loadLoginShellPath();
    const lsp = new LspManager(message => window.send(IpcChannels.lspMessage, message), shellReady);
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
        onChanged: () => window.send(IpcChannels.reviewProvidersChanged)
    });

    const tasks = new TaskHost({
        pluginFolders: [
            // The packaged app keeps the built-in plugins outside the asar archive, because a process cannot start in an archive folder.
            { path: app.isPackaged ? join(process.resourcesPath, 'plugins') : join(app.getAppPath(), 'plugins'), builtIn: true },
            { path: join(os.homedir(), '.shipwarden', 'plugins'), builtIn: false }
        ],
        settings: new PluginSettings(join(userData, 'plugin-settings.json')),
        repoFor: root => reviewProviders.githubRepoFor(root),
        projectRepos: async projectId => (await projects.get()).projects.find(project => project.id === projectId)?.repos ?? [],
        configFile: join(userData, 'task-managers.json'),
        legacySourcesFile: join(userData, 'task-sources.json'),
        linksFile: join(userData, 'task-links.json'),
        collectionsFile: join(userData, 'task-collections.json'),
        selectedConnectionsFile: join(userData, 'task-selected-connections.json'),
        onChanged: (connectionId, projectId) => window.send(IpcChannels.tasksChanged, connectionId, projectId),
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
        olderSocketPaths: [ptyHostSocketPath(userData), ...LEGACY_NAMES.map(name => ptyHostSocketPath(join(app.getPath('appData'), name)))],
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

    /** The HTTPS server for the phone app. It runs only while Settings › Mobile has it on. */
    const remote = new RemoteServer({
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
            approvePullRequest: async (worktreePath, number, headSha, body) => {
                const worktree = await projectWorktrees.check(worktreePath);
                await (await reviewProviders.for(worktree)).submitReview(worktree, number, headSha, 'APPROVE', body, []);
                remoteSnapshot.invalidate();
            },
            onStatusChanged: () => window.send(IpcChannels.remoteChanged)
        }
    });

    /** The worktrees and the repositories of the projects. */
    const projectWorktrees = new ProjectWorktrees({
        projectRepos: async () => (await projects.get()).projects.flatMap(project => project.repos),
        worktreePaths: async repo => (await worktrees.list(repo)).map(item => item.path),
        isReviewCheckout: path => reviewCheckouts.has(path),
        githubRepoFor: root => reviewProviders.githubRepoFor(root)
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

    const askRunner = new AskAgentRunner();
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
        usage,
        settings,
        seen,
        answers,
        reviewCheckouts,
        codeAnswers,
        notifications,
        notes,
        ptyHostLog,
        terminalSizes,
        remote,
        projectWorktrees,
        askRunner,
        confirm,
        hookPaths,
        shellIntegration
    };
}
