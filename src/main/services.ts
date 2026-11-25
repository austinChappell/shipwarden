import { basename, join } from 'path';
import { mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import * as os from 'os';
import { execFile } from 'child_process';
import { app, shell } from 'electron';
import { IpcChannels } from '@shared/api';
import type { ShellIntegration } from './agents/shell-integration';
import { ShellAgents } from './agents/shell-agents';
import { AskAgentRunner } from './agents/ask-agent';
import { hookSettingsPaths } from './agents/hook-files';
import { OpencodeVersions } from './agents/opencode-version';
import type { MainWindow } from './app/main-window';
import { ConfirmDialogs } from './app/confirm';
import { FileService } from './files/file-service';
import { FileWatcher } from './files/file-watcher';
import { LspManager } from './lsp/lsp-manager';
import { setManagedFolder } from './lsp/servers';
import { ServerInstaller } from './lsp/server-install';
import { PluginSettings } from './tasks/plugin-settings';
import { TaskHost } from './tasks/task-host';
import { mainWorktreeRoot, ProjectStore } from './project-store';
import { loadLoginShellPath, loginShellCaFile } from './shell-env';
import { TrustedCertificates } from './network/trusted-certificates';
import { NotesService } from './notes/notes-service';
import { AutomationStore } from './automations/automation-store';
import { EngineLock, EngineLockKeeper, engineLockPath } from './automations/engine-lock';
import { pendingRemoteRuns } from '@shared/automation-engine';
import { PromptStore } from './prompts/prompt-store';
import { PlanStore } from './plans/plan-store';
import { Coordinators } from './coordinator/coordinators';
import { PrGroupStore } from './pr-groups/pr-group-store';
import { CompareStore } from './compare/compare-store';
import { QueueStore } from './queue/queue-store';
import { StatsRecorder } from './stats/stats-recorder';
import { StatsStore } from './stats/stats-store';
import { TokenCounter } from './automations/token-counter';
import { PinnedSessions } from './agents/pinned-sessions';
import { RecentSessions } from './agents/recent-sessions';
import { TranscriptIndex } from './agents/transcript-index';
import { printCommand } from '@shared/ask-agent';
import { agentProgramOf } from '@shared/agent-programs';
import { LEGACY_NAMES } from './legacy-migration';
import { NotificationService } from './notifications';
import { buildSocketPath, ptyHostSocketFolder, ptyHostSocketPath } from './pty-host/protocol';
import { hostBuildId, PtyHostClient } from './pty-host/pty-host-client';
import { ProcessService } from './processes/process-service';
import { StaleShellCloser } from './terminal/stale-shells';
import { bundlePathOf, UpdateService } from './updates/update-service';
import { GitChangesService } from './git/git-changes-service';
import { CheckpointRecorder } from './git/checkpoint-recorder';
import { createCheckpoint, pruneCheckpoints } from './git/checkpoints';
import { GitWorktreeService } from './worktrees/git-worktree-service';
import { ProjectWorktrees } from './worktrees/project-worktrees';
import { SettingsStore } from './settings-store';
import { SeenStore } from './seen-store';
import { SnoozeStore } from './snooze-store';
import { AnswersStore, CodeAnswersStore } from './answers-store';
import { ReviewCheckouts } from './review/review-checkouts';
import { ReviewProviders } from './review-providers';
import { UsageService } from './usage/usage-service';
import { PushSender } from './push/push-notifier';
import { RemoteDevices } from './remote/remote-devices';
import { HttpError, localHosts, RemoteServer } from './remote/remote-server';
import { RemoteSnapshotBuilder } from './remote/remote-snapshot';
import { ensureTlsIdentity } from './remote/tls-identity';
import { connectHelper } from './helper/helper-link';
import { helperPlist, LaunchAgent } from './helper/launch-agent';
import { HELPER_LABEL, helperSocketPath } from './helper/protocol';
import { RemoteControl } from './helper/remote-control';
import { BrowserViews } from './browser/browser-views';
import { ScreenshotService } from './screenshots/screenshot-service';
import { ScreenshotStore } from './screenshots/screenshot-store';
import { checkCommand } from './command-check';
import { SetupChecks } from './setup-checks';
import { McpHost } from './mcp/mcp-host';
import { worktreesFromSnapshot } from './mcp/worktree-list';
import { isCliWriteAction, writeToolLabel } from '@shared/mcp';
import { CLI_NAME, type CliPageRequest, type CliPageResult } from '@shared/cli';
import { CliActions } from './cli/cli-actions';
import { CliHost } from './cli/cli-host';
import { CliInstaller } from './cli/cli-install';
import { CliPageBridge } from './cli/page-bridge';
import { CliError } from './cli/cli-server';
import { RemoteStarter } from './remote/remote-start';
import { SlackApi } from './slack/slack-api';
import { SlackBridge } from './slack/slack-bridge';
import { SlackTokenStore } from './slack/slack-tokens';
import { cliConfigPath, cliSocketPath } from './cli/paths';
import { AgentBrowser } from './browser/agent-browser';
import { findOverlaps } from '@shared/worktree-overlap';
import { agentForRepo } from '@shared/settings';

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
    /** The pinned sessions. The terminal events use it, so it is set below with the other stores. */
    let pinnedSessions!: PinnedSessions;
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
    /**
     * The in-app browser. Each browser tab of a page has a WebContentsView in the window of that page. The events of a
     * view go to that window only.
     */
    const sendToBrowserOwner = (id: string, channel: string, ...args: unknown[]) => {
        const owner = browserViews.ownerOf(id);
        if (owner && !owner.isDestroyed()) owner.webContents.send(channel, ...args);
    };
    const browserViews = new BrowserViews(() => certificates.extraCertificates(), {
        onState: state => sendToBrowserOwner(state.id, IpcChannels.browserStateChanged, state),
        onOpenTab: (url, openerId) => sendToBrowserOwner(openerId, IpcChannels.browserOpenTab, url, openerId),
        onFocus: id => sendToBrowserOwner(id, IpcChannels.browserFocused, id),
        onInput: (id, input) => onBrowserInput(id, input),
        onFound: (id, active, matches) => sendToBrowserOwner(id, IpcChannels.browserFound, id, active, matches)
    });
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
     * The event log of the agent stats (`agent-stats.jsonl`). It removes the lines older than 90 days at start.
     * The functions run later, at the first event, so they can use the services below.
     */
    const statsStore = new StatsStore(join(userData, 'agent-stats.jsonl'));
    void statsStore.prune();
    const statsTokens = new TokenCounter();
    const stats = new StatsRecorder({
        store: statsStore,
        session: async id => (await terminalSessions()).find(session => session.id === id),
        repoOf: worktree => reviewProviders.repoFor(worktree),
        tokens: async transcript => (await statsTokens.count(transcript, 0)).tokens,
        programOf: async name => {
            const agent = (await settings.get()).agents.find(item => item.name === name);
            return agent ? agentProgramOf(agent.command.trim()) : undefined;
        }
    });

    /**
     * The search index of the Claude Code transcripts (Agents view). It reads the new lines of a transcript at each agent
     * state change and at each change that the chat watch sees. A scan finds the other transcripts.
     */
    const transcriptIndex = new TranscriptIndex({ file: join(userData, 'transcript-index.db') });

    /**
     * Saves a git checkpoint of the worktree at each agent turn (Checkpoints tab). The work runs after the hook answered,
     * so it never delays the agent.
     */
    const checkpoints = new CheckpointRecorder({
        session: async id => (await terminalSessions()).find(session => session.id === id),
        create: createCheckpoint,
        onSaved: cwd => window.send(IpcChannels.checkpointsChanged, cwd)
    });
    /** Removes the checkpoints that are older than 7 days. It runs one time, at the start of the app. */
    const pruneOldCheckpoints = async () => {
        const repos = new Set((await projects.get()).projects.flatMap(project => project.repos));
        for (const repo of repos) {
            await pruneCheckpoints(repo).catch(error => console.warn(`[checkpoints] The cleanup of ${repo} failed: ${String(error)}`));
        }
    };

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
                checkpoints.output(id);
                remote.terminalData(id, data, seq);
            },
            exit: (id, exitCode) => {
                void mcp.revokeSession(id).catch(() => undefined);
                slack.forget(id);
                coordinators.sessionExited(id);
                shellAgents.forget(id);
                stats.forget(id);
                checkpoints.forget(id);
                window.send(IpcChannels.terminalsExit, id, exitCode);
                remote.terminalExited(id);
            },
            agentState: (id, update) => {
                window.send(IpcChannels.terminalsAgentState, id, update);
                stats.agentState(id, update);
                checkpoints.agentState(id, update);
                // A resumed session can write its transcript in a new folder. The pin follows it.
                void pinnedSessions.track(update.transcript).catch(() => undefined);
                transcriptIndex.update(update.transcript);
                remote.agentsChanged();
                remote.agentState(id, update.state);
                slack.agentState(id, update);
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
            stats.agentState(id, update);
            remote.agentsChanged();
            remote.agentState(id, update.state);
            slack.agentState(id, update);
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
    const snoozes = new SnoozeStore(join(userData, 'snoozes.json'));
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
    /** The prompt templates are files in the home folder too, so the user can share them. */
    const prompts = new PromptStore(join(os.homedir(), '.shipwarden', 'prompts'), file => shell.trashItem(file));
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

    /**
     * The automation lock (see `EngineLock`). The app wants it while a window is open, because the page runs the
     * automations and the task queue. While no window is open, the background helper can take it. The helper can change
     * the run file, the queue file, and the task links, so the stores read their files again when the app gets the lock.
     */
    const engineOwnership = new EngineLockKeeper({
        lock: new EngineLock({ file: engineLockPath(userData), owner: 'app' }),
        wanted: () => window.all().length > 0,
        onAcquire: async () => {
            await Promise.all([automations.reloadRuns(), queue.reload(), tasks.reloadLinks()]);
        },
        onRelease: () => undefined,
        onOwnedChanged: owned => {
            window.send(IpcChannels.automationsEngineChanged, owned);
            void slack.setActive(owned);
        },
        log: message => console.info(`[automations] ${message}`)
    });

    /** The automation runs that are waiting for approval, for the phone. */
    const pendingRunsForPhone = async () => pendingRemoteRuns(await automations.runState());

    /** Approves or skips a run for the phone. The page runs the engine, so the answer goes to the page. */
    async function answerRunForPhone(id: string, approve: boolean): Promise<void> {
        const page = window.get();
        if (!engineOwnership.owns || !page || page.isDestroyed()) {
            throw new HttpError(503, 'The ShipWarden window is closed. Open it on the Mac, then try again.');
        }
        const run = (await automations.runState()).runs.find(item => item.id === id);
        if (run?.status !== 'pending') throw new HttpError(409, 'The run is not waiting for approval anymore.');
        page.webContents.send(IpcChannels.automationsAnswerRun, id, approve);
    }

    /** The bridge to the page. The `shipwarden` CLI and the phone use it for the work that the page owns. */
    const cliPage = new CliPageBridge(() => window.get());

    /** Sends a request of the phone to the page. A page error becomes an HTTP error for the phone. 503: no window is open. */
    async function pageForPhone(request: CliPageRequest): Promise<CliPageResult> {
        try {
            return await cliPage.request(request, new AbortController().signal);
        } catch (error) {
            if (!(error instanceof CliError)) throw error;
            throw new HttpError(error.code === 'noWindow' ? 503 : error.code === 'timeout' ? 504 : 409, error.message);
        }
    }

    /**
     * Starts agents for the phone with the start code of "Start in worktree" in the page. The main process checks the
     * values and the usage budget first.
     */
    const phoneStarter = new RemoteStarter({
        settings: () => settings.get(),
        projects: async () => (await projects.get()).projects,
        usage: async () => usage.get(),
        tasks: async () => {
            const result = await pageForPhone({ action: 'phone.tasks' });
            return { tasks: result.tasks ?? [], ...(result.tasksNote ? { note: result.tasksNote } : {}) };
        },
        start: async start => {
            const result = await pageForPhone({ action: 'phone.start', ...start });
            if (!result.sessionId || !result.worktreePath) throw new HttpError(500, 'The ShipWarden window did not send the new agent.');
            return { sessionId: result.sessionId, worktreePath: result.worktreePath };
        },
        sessions: terminalSessions,
        worktrees: repo => worktrees.list(repo),
        taskLinks: () => tasks.allLinks()
    });

    /**
     * Sends push notifications to the paired phones through the push relay (Settings › Mobile). The phone server sends
     * "Agent needs input" while this process runs it. The approvals go out from the process that runs the automations.
     */
    const push = new PushSender({
        settings: async () => (await settings.get()).remote,
        devices: () => new RemoteDevices(join(userData, 'remote-devices.json')),
        ready: networkReady,
        log: message => console.warn(`[push] ${message}`)
    });

    /**
     * The Slack connection (Settings › Slack). It runs in the process that holds the automation lock: here while a
     * window is open, else in the background helper. The tokens are in the keychain, so the helper can read them too.
     */
    const slackTokens = new SlackTokenStore(userData);
    const slack = new SlackBridge({
        settings: () => settings.get(),
        tokens: () => slackTokens.get(),
        projects: async () => (await projects.get()).projects,
        sessions: () => (terminals.isConnected() ? terminalSessions() : Promise.resolve([])),
        write: (id, data) => terminals.write(id, data),
        start: request => phoneStarter.start(request),
        threadsFile: join(userData, 'slack-threads.json'),
        api: new SlackApi({ ready: networkReady }),
        log: message => console.info(`[slack] ${message}`),
        onStatus: status => window.send(IpcChannels.slackChanged, status)
    });

    /** The HTTPS server for the phone app in this process. Each call makes a new server, which reads the paired phones again. */
    const createLocalRemote = () =>
        new RemoteServer({
            devices: new RemoteDevices(join(userData, 'remote-devices.json')),
            identity: () => ensureTlsIdentity(userData),
            hosts: () => localHosts(localHostName),
            push,
            backend: {
                macName: () => computerName,
                version: app.getVersion(),
                snapshot: () => remoteSnapshot.build(),
                // The size from the page is newer than the size of an older PTY host, which has none.
                sessions: async () => (await terminalSessions()).map(session => ({ ...session, ...terminalSizes.get(session.id) })),
                replay: id => terminals.replay(id),
                write: (id, data) => terminals.write(id, data),
                approvePullRequest: approveForPhone,
                pendingRuns: pendingRunsForPhone,
                answerRun: answerRunForPhone,
                startOptions: () => phoneStarter.options(),
                startAgent: body => phoneStarter.start(body),
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
                answerRun: ({ id, approve }) => answerRunForPhone(String(id), approve === true),
                startOptions: () => phoneStarter.options(),
                startAgent: body => phoneStarter.start(body),
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

    /** Screenshots of visual changes. The images go to `<app data>/screenshots`. */
    const screenshots = new ScreenshotService({
        store: new ScreenshotStore(userData),
        checkWorktree: worktree => projectWorktrees.check(worktree),
        repoOf: async worktree => (await projectWorktrees.repoOf(worktree)) ?? (await mainWorktreeRoot(worktree)),
        settingsOf: async repo => (await settings.get()).repos[repo]?.screenshots,
        capture: (url, options) => browserViews.capture(url, options),
        hostFor: worktree => reviewProviders.for(worktree),
        onProgress: progress => window.send(IpcChannels.screenshotsProgress, progress)
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
    const compare = new CompareStore(join(userData, 'agent-compare.json'));
    const queue = new QueueStore(join(userData, 'task-queue.json'));
    /**
     * The pinned Claude Code sessions. The agent that ran the session names it in print mode, with a small model. The
     * run saves no session and uses an empty temporary folder, so it does not add a session to the resume list.
     */
    pinnedSessions = new PinnedSessions({
        file: join(userData, 'pinned-sessions.json'),
        onChanged: pins => window.send(IpcChannels.pinsChanged, pins),
        ask: async (pin, prompt) => {
            await shellReady;
            const { agents } = await settings.get();
            const claude = agents.filter(agent => agentProgramOf(agent.command.trim()) === 'claude');
            const agent = claude.find(item => item.id === pin.agentId) ?? claude[0];
            const print = agent ? printCommand(agent.command) : undefined;
            if (!print) throw new Error('No Claude Code agent is in Settings › Agents.');
            const cwd = join(app.getPath('temp'), 'shipwarden-ask');
            await mkdir(cwd, { recursive: true });
            await networkReady;
            const bundle = certificates.status().bundlePath;
            return askRunner.run(`pin-name:${pin.id}`, {
                command: `${print} --model haiku --no-session-persistence`,
                prompt,
                cwd,
                env: bundle ? { NODE_EXTRA_CA_CERTS: bundle } : {},
                timeoutMs: 2 * 60_000
            });
        }
    });
    const confirm = new ConfirmDialogs(() => window.get());

    /**
     * The coordinator runs: the MCP tool start_worker starts worker agents in new worktrees through the page. The runs
     * are plans in the plan file. The page shows them in the Plans view and patches its cache with each change.
     */
    const coordinators = new Coordinators({
        plans,
        settings: () => settings.get(),
        projects: async () => (await projects.get()).projects,
        usage: async () => usage.get(),
        queue: () => queue.get(),
        sessions: () => (terminals.isConnected() ? terminalSessions() : Promise.resolve([])),
        repoOf: worktree => projectWorktrees.repoOf(worktree),
        start: async (start, signal) => {
            const result = await cliPage.request({ action: 'worker.start', ...start }, signal);
            if (!result.sessionId || !result.worktreePath) throw new Error('The ShipWarden window did not send the new worker.');
            return { worktreePath: result.worktreePath, sessionId: result.sessionId, ...(result.branch ? { branch: result.branch } : {}) };
        },
        send: async ({ repoPath, worktree, sessionId }, message) => {
            await cliPage.request({ action: 'agent.send', repoPath, worktreePath: worktree, prompt: message, sessionId }, new AbortController().signal);
        },
        pullRequest: async worktree => {
            const pr = (await reviewProviders.branchStatus(worktree))?.pullRequest;
            return pr ? { number: pr.number, url: pr.url, base: pr.baseRefName } : undefined;
        },
        onPlanChanged: plan => window.send(IpcChannels.plansChanged, plan)
    });
    coordinators.start();

    /**
     * The ShipWarden MCP server (Settings › Agents). Claude Code, Codex, Gemini CLI, and opencode agents get it at start. The tools act on the worktree of
     * the agent's token. The write tools ask the user the first time in each worktree, in the dialog of the page.
     */
    const mcp = new McpHost({
        userData,
        version: app.getVersion(),
        geminiHookSettingsPath: hookSettingsPaths(userData).gemini,
        askUser: ({ worktree, tool, summary }, signal) =>
            confirm.ask(
                {
                    title: `${writeToolLabel(tool)}?`,
                    message: isCliWriteAction(tool)
                        ? `A ${CLI_NAME} command wants to act on "${basename(worktree)}".\n\n${summary}\n\nAllow applies to this command in this folder until you revoke it in Settings › Agents. Without an answer in 2 minutes, the command fails.`
                        : `The agent in "${basename(worktree)}" wants to use the ShipWarden tool ${tool}.\n\n${summary}\n\nAllow applies to ${tool} in this worktree until you revoke it in Settings › Agents. Without an answer in 2 minutes, the tool call fails.`,
                    confirmLabel: 'Allow',
                    cancelLabel: 'Deny'
                },
                signal
            ),
        onApprovalsChanged: approvals => window.send(IpcChannels.mcpApprovalsChanged, approvals),
        onWatchesChanged: watches => window.send(IpcChannels.mcpWatchesChanged, watches),
        service: {
            worktrees: async (caller, all) => worktreesFromSnapshot(await remoteSnapshot.build(), caller, all),
            overlap: async caller => {
                const repo = await projectWorktrees.repoOf(caller);
                if (!repo) return undefined;
                const files = await gitChanges.worktreeFiles(repo, await worktrees.list(repo));
                return findOverlaps(files)[caller];
            },
            ask: async (target, prompt, { timeoutMs, signal }) => {
                await shellReady;
                const cwd = await projectWorktrees.check(target);
                const agent = agentForRepo(await settings.get(), await projectWorktrees.repoOf(cwd));
                const command = printCommand(agent.command);
                if (!command)
                    throw new Error(`ShipWarden can ask only Claude Code, Codex, Gemini CLI, or opencode. The agent of the other worktree is "${agent.name}".`);
                await networkReady;
                const bundle = certificates.status().bundlePath;
                const id = `mcp:${randomUUID()}`;
                const cancel = () => askRunner.cancel(id);
                signal.addEventListener('abort', cancel, { once: true });
                try {
                    const answer = await askRunner.run(id, { command, prompt, cwd, env: bundle ? { NODE_EXTRA_CA_CERTS: bundle } : {}, timeoutMs });
                    return { agent: agent.name, answer };
                } finally {
                    signal.removeEventListener('abort', cancel);
                }
            },
            linkedTask: async caller => {
                const link = (await tasks.allLinks())[caller];
                if (!link) return undefined;
                const connectionId = link.connectionId ?? link.pluginId;
                return { connectionId, link, capabilities: (await tasks.source(connectionId)).capabilities };
            },
            taskRequest: <T>(connectionId: string, method: string, params: unknown) => tasks.request(connectionId, method, params) as Promise<T>,
            taskChanged: (connectionId, taskId, patch) => window.send(IpcChannels.tasksTaskChanged, connectionId, taskId, patch),
            pullRequests: {
                status: worktree => reviewProviders.branchStatus(worktree),
                create: async (worktree, request) => (await reviewProviders.for(worktree)).createPullRequest(worktree, request),
                change: async (worktree, number, change) => (await reviewProviders.for(worktree)).changePullRequest(worktree, number, change),
                reply: async (worktree, number, commentId, body) => (await reviewProviders.for(worktree)).replyToComment(worktree, number, commentId, body),
                checks: async (worktree, sha) => (await reviewProviders.for(worktree)).checks(worktree, sha),
                saveJobLog: async (worktree, jobId) => (await reviewProviders.for(worktree)).saveJobLog(worktree, jobId),
                changed: change => window.send(IpcChannels.mcpPullRequestChanged, change)
            },
            // The page opens the tab of the worktree without a change of the selected worktree or tab.
            browser: new AgentBrowser({ views: browserViews, requestTab: (url, worktree) => window.send(IpcChannels.browserAgentOpen, url, worktree) }),
            workers: coordinators
        }
    });
    /**
     * The `shipwarden` CLI. Its local socket runs in this process now. The commands use the MCP tools and the same
     * approvals. The commands that act on agent tabs, the worktree list, and the automations go to the page.
     * `CliServer` uses no Electron API, so the background helper can run it later.
     */
    const cli = new CliHost({
        socketPath: cliSocketPath(userData),
        configPath: cliConfigPath(os.homedir(), process.env, separateDataFolder ? userData : undefined),
        version: app.getVersion(),
        pid: process.pid,
        handler: new CliActions({
            version: app.getVersion(),
            pid: process.pid,
            home: os.homedir(),
            mcpServer: async () => (await settings.get()).mcpServer,
            worktrees: async () => worktreesFromSnapshot(await remoteSnapshot.build(), '', true),
            tools: mcp.tools,
            approve: (request, signal) => mcp.approve(request, signal),
            sessions: () => (terminals.isConnected() ? terminalSessions() : Promise.resolve([])),
            automations: async () => (await automations.list()).automations,
            page: (request, signal) => cliPage.request(request, signal)
        })
    });
    /** Settings › Agents › "Install the shipwarden command". The link goes to the launcher script in the app. */
    const cliInstaller = new CliInstaller({
        launcher: app.isPackaged ? join(process.resourcesPath, 'bin', CLI_NAME) : join(app.getAppPath(), 'bin', CLI_NAME),
        home: os.homedir(),
        alias: async () => {
            const { cliAlias } = await settings.get();
            return cliAlias.enabled ? cliAlias.name : undefined;
        },
        path: async () => {
            await shellReady;
            return process.env.PATH ?? '';
        }
    });
    const hookPaths = hookSettingsPaths(userData);
    /** The shell setup that adds the hook settings to a `claude`, `gemini` or `opencode` that the user types in a shell tab. */
    const shellIntegration: ShellIntegration = { hookSettingsPath: hookPaths.claude, geminiHookSettingsPath: hookPaths.gemini };
    const opencodeVersions = new OpencodeVersions(shellReady);

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
        snoozes,
        answers,
        reviewCheckouts,
        codeAnswers,
        notifications,
        notes,
        automations,
        engineOwnership,
        prompts,
        ptyHostLog,
        terminalSizes,
        remote,
        push,
        slack,
        slackTokens,
        projectWorktrees,
        screenshots,
        askRunner,
        plans,
        coordinators,
        prGroups,
        compare,
        queue,
        stats,
        checkpoints,
        pruneOldCheckpoints,
        pinnedSessions,
        recentSessions: new RecentSessions(),
        transcriptIndex,
        confirm,
        mcp,
        cli,
        cliPage,
        cliInstaller,
        hookPaths,
        shellIntegration,
        opencodeVersions,
        setupChecks
    };
}
