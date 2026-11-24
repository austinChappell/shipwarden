/**
 * The entry point of the background helper.
 * A macOS launch agent starts it with Electron's Node runtime (ELECTRON_RUN_AS_NODE=1), at login and after a stop.
 * It runs the phone server while ShipWarden is closed. The agents stay in the PTY host.
 * When the user turns on "Run while ShipWarden is closed", it also runs the schedule and CI automations and the task
 * queue while no ShipWarden window is open (see `HelperAutomations`).
 * Arguments: <app data folder> <app version>.
 */
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { homedir, hostname, userInfo } from 'os';
import { dirname, join, relative, resolve, isAbsolute } from 'path';
import { ResponseError } from 'vscode-jsonrpc/node';
import { pendingRemoteRuns } from '@shared/automation-engine';
import { normalizeRunState } from '@shared/automations';
import { normalizeProjects } from '@shared/projects';
import type { TaskLink } from '@shared/tasks';
import type { TerminalSession } from '@shared/terminal';
import { hookSettingsPaths } from '../agents/hook-files';
import { ShellAgents } from '../agents/shell-agents';
import { shellIntegrationEnv } from '../agents/shell-integration';
import { sendHttpRequest } from '../automations/http-request';
import { GitHubClient } from '../github/github-client';
import { GitHubService } from '../github/github-service';
import { TrustedCertificates } from '../network/trusted-certificates';
import { LEGACY_NAMES } from '../legacy-migration';
import { ProcessService } from '../processes/process-service';
import { buildSocketPath, ptyHostSocketFolder, ptyHostSocketPath } from '../pty-host/protocol';
import { hostBuildId, PtyHostClient } from '../pty-host/pty-host-client';
import { RemoteDevices } from '../remote/remote-devices';
import { HttpError, localHosts, RemoteServer } from '../remote/remote-server';
import { RemoteSnapshotBuilder } from '../remote/remote-snapshot';
import { RemoteStarter } from '../remote/remote-start';
import { ensureTlsIdentity } from '../remote/tls-identity';
import { SettingsStore } from '../settings-store';
import { ScreenMirror } from '../remote/screen-mirror';
import { loadLoginShellPath, loginShellCaFile } from '../shell-env';
import { JsonStore } from '../tasks/json-store';
import { UsageService } from '../usage/usage-service';
import { GitWorktreeService, worktreesRoot } from '../worktrees/git-worktree-service';
import { HelperAgents } from './headless-agents';
import { HelperAutomations } from './helper-automations';
import { HelperServer } from './helper-server';
import { helperSocketPath } from './protocol';

const [userData, version = 'unknown'] = process.argv.slice(2);

function log(message: string): void {
    console.log(`${new Date().toISOString()} [helper] ${message}`);
}

if (!userData) {
    console.error('[helper] The app data folder is missing. Usage: helper <app data folder> <app version>');
    process.exit(2);
}

const ptyHostScript = join(__dirname, 'pty-host.js');
const reviewFolder = join(homedir(), '.shipwarden', 'review');
/** The terminal sizes that the page sent. A session of an older PTY host has no size. */
const terminalSizes = new Map<string, { cols: number; rows: number }>();

function scutil(key: string): Promise<string | undefined> {
    return new Promise(done => {
        execFile('/usr/sbin/scutil', ['--get', key], (error, stdout) => done(!error && stdout.trim() ? stdout.trim() : undefined));
    });
}

let computerName = hostname().replace(/\.local$/, '');
let localHostName: string | undefined;
void scutil('ComputerName').then(name => {
    if (name) computerName = name;
});
void scutil('LocalHostName').then(name => {
    localHostName = name;
});

const terminals = new PtyHostClient({
    socketPath: buildSocketPath(ptyHostSocketFolder(userData), hostBuildId(ptyHostScript)),
    olderSocketPaths: [ptyHostSocketPath(userData), ...LEGACY_NAMES.map(name => ptyHostSocketPath(join(dirname(userData), name)))],
    hostScript: ptyHostScript,
    logPath: join(userData, 'pty-host.log'),
    events: {
        data: (id, data, seq) => remote.terminalData(id, data, seq),
        exit: id => {
            shellAgents.forget(id);
            remote.terminalExited(id);
        },
        agentState: () => remote.agentsChanged()
    }
});

const processes = new ProcessService({ sessions: () => terminals.list(), hostPids: () => terminals.hostPids() });

/** Finds the agents in shell tabs, as the app does. The helper has its own scan, because the app can be closed. */
const shellAgents = new ShellAgents({
    sessions: () => (terminals.isConnected() ? terminals.list() : Promise.resolve([])),
    hostPids: () => terminals.hostPids(),
    processTable: () => processes.table(),
    onState: () => remote.agentsChanged(),
    onProgram: () => remote.agentsChanged()
});

const sessions = async (): Promise<TerminalSession[]> => shellAgents.annotate(await terminals.list());

function inReviewFolder(target: string): boolean {
    const path = relative(reviewFolder, resolve(target));
    return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

/**
 * The snapshot while the app is closed. Each call reads the files again, because the app changes them.
 * It has no pull requests: only the app reads GitHub and Azure DevOps (with its tokens and trusted certificates).
 */
const worktrees = new GitWorktreeService();
const ownSnapshot = new RemoteSnapshotBuilder({
    projects: async () => normalizeProjects(JSON.parse(await fs.readFile(join(userData, 'projects.json'), 'utf8').catch(() => '{}')), randomUUID),
    worktrees: async repo => (await worktrees.list(repo)).filter(item => !inReviewFolder(item.path)),
    settings: () => new SettingsStore(join(userData, 'settings.json')).get(),
    taskLinks: () => new JsonStore<Record<string, TaskLink>>(join(userData, 'task-links.json'), () => ({})).get(),
    pullRequests: () => Promise.reject(new Error('The helper does not read pull requests.')),
    sessions
});

const settingsFile = join(userData, 'settings.json');
const readSettings = () => new SettingsStore(settingsFile).get();
const readProjects = async () =>
    normalizeProjects(JSON.parse(await fs.readFile(join(userData, 'projects.json'), 'utf8').catch(() => '{}')), randomUUID).projects;

/**
 * The network requests of the automations use the extra CA certificates of Settings › Network, as in the app. They
 * apply after the login shell PATH loads (in `main`).
 */
const certificates = new TrustedCertificates(join(userData, 'trusted-ca.pem'));
let networkStarted: () => void = () => undefined;
const networkReady = new Promise<void>(resolve => {
    networkStarted = resolve;
});
/**
 * GitHub for the CI automations. The token comes from GITHUB_TOKEN or the GitHub CLI. The saved tokens of
 * Settings › Code review are encrypted with the keychain of the app, so the helper cannot read them.
 */
const github = new GitHubService(new GitHubClient({ ready: networkReady }));

/** The text of the screen of a session, from the output of the PTY host. */
async function screenText(id: string): Promise<string | undefined> {
    const session = terminalSizes.get(id) ?? (await terminals.list()).find(item => item.id === id);
    const mirror = new ScreenMirror(session?.cols ?? 120, session?.rows ?? 32);
    try {
        const replay = await terminals.replay(id);
        await mirror.write(replay.data, replay.seq);
        return mirror.screenText();
    } catch {
        return undefined;
    } finally {
        mirror.dispose();
    }
}

const hookPaths = hookSettingsPaths(userData);
const helperAgents = new HelperAgents({
    terminals,
    worktrees,
    settings: readSettings,
    hookPaths,
    env: () => {
        // launchd starts the helper with ELECTRON_RUN_AS_NODE. An agent must not get it: an Electron app in its shell would run as Node.
        const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env;
        return { ...env, ...shellIntegrationEnv(env, { hookSettingsPath: hookPaths.claude, geminiHookSettingsPath: hookPaths.gemini }) };
    },
    worktreesRoot: worktreesRoot(),
    home: homedir(),
    username: userInfo().username,
    saveTaskLink: (path, link) =>
        new JsonStore<Record<string, TaskLink>>(join(userData, 'task-links.json'), () => ({})).update(all => ({ ...all, [path]: link })).then(() => undefined),
    screenText,
    log: message => log(`[agents] ${message}`)
});

/** Shows a macOS notification when Settings › Notifications allows the "Automations" event. */
function notify(title: string, body: string): void {
    void readSettings().then(settings => {
        const { enabled, events } = settings.notifications;
        if (!enabled || !events.automation.enabled) return;
        const script = `display notification ${JSON.stringify(body)} with title "ShipWarden" subtitle ${JSON.stringify(title)}`;
        execFile('/usr/bin/osascript', ['-e', script], error => {
            if (error) log(`The notification did not show: ${error.message}`);
        });
    });
}

const automations = new HelperAutomations({
    userData,
    automationsFolder: join(homedir(), '.shipwarden', 'automations'),
    settings: readSettings,
    places: async () => {
        const repos = [...new Set((await readProjects()).flatMap(project => project.repos))];
        const lists = await Promise.all(repos.map(async repo => (await worktrees.list(repo).catch(() => [])).map(worktree => ({ repo, worktree }))));
        return lists.flat().filter(place => !inReviewFolder(place.worktree.path));
    },
    agents: helperAgents,
    github: {
        branchSummaries: root => github.branchSummaries(root),
        checks: async (root, sha) => {
            const repo = await github.repoFor(root);
            return repo ? github.checks(repo, sha) : [];
        },
        saveJobLog: async (root, jobId) => {
            const repo = await github.repoFor(root);
            if (!repo) throw new Error('The worktree has no GitHub repository.');
            return github.saveJobLog(repo, jobId);
        }
    },
    http: request => sendHttpRequest(request, networkReady),
    notify,
    log: message => log(`[automations] ${message}`)
});

/** The pending runs come from the run file. The owner of the automation lock writes it, so each call reads it again. */
async function pendingRuns() {
    const text = await fs.readFile(join(userData, 'automation-runs.json'), 'utf8').catch(() => '{}');
    try {
        return pendingRemoteRuns(normalizeRunState(JSON.parse(text)));
    } catch {
        return [];
    }
}

/** Approves or skips a run for the phone: in the helper when it runs the automations, else in the open app. */
async function answerRun(id: string, approve: boolean): Promise<void> {
    try {
        if (await automations.answerRun(id, approve)) return;
    } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : String(error));
    }
    if (!control.hasApp()) {
        throw new HttpError(503, 'Open ShipWarden on the Mac, or turn on "Run while ShipWarden is closed" in Automations, to answer this run.');
    }
    try {
        await control.appAnswerRun({ id, approve });
    } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : String(error));
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The plan usage for the usage budget of a start from the phone. The helper has no timer for it. It loads only when the
 * phone opens the start screen or starts an agent, and Settings › Agents has a budget. The service waits between
 * two requests, the same as in the app.
 */
const usage = new UsageService(`ShipWarden/${version}`, () => undefined);

/** Starts agents for the phone while the app is closed: a new worktree and the agent through the PTY host. */
const ownStarter = new RemoteStarter({
    settings: readSettings,
    projects: readProjects,
    usage: async () => {
        await networkReady;
        return usage.refresh();
    },
    tasks: async () => ({ tasks: [], note: 'Open ShipWarden on the Mac to start an agent on a task.' }),
    start: async start => {
        if (start.task) throw new HttpError(503, 'Open ShipWarden on the Mac to start an agent on a task.');
        const branch = start.branch ?? start.promptBranch;
        if (!branch) throw new HttpError(400, 'The start has no branch.');
        let started: Awaited<ReturnType<HelperAgents['startInNewWorktree']>>;
        try {
            started = await helperAgents.startInNewWorktree(start.repoPath, branch, '', start.agentId, undefined, start.model);
        } catch (error) {
            throw new HttpError(409, errorMessage(error));
        }
        const { worktree, session } = started;
        // The phone shows the agent at once. The prompt goes in when the agent is ready and shows no question.
        if (start.prompt) {
            void helperAgents
                .promptAgent(worktree.path, start.prompt, { sessionId: session.id })
                .catch(error => log(`[agents] The prompt did not reach ${session.title}: ${errorMessage(error)}`));
        }
        return { worktreePath: worktree.path, sessionId: session.id };
    },
    sessions,
    worktrees: repo => worktrees.list(repo),
    taskLinks: () => new JsonStore<Record<string, TaskLink>>(join(userData, 'task-links.json'), () => ({})).get()
});

/** The HTTP status of an error of the app. The app sends the status of its `HttpError` as the error code. */
function appStatus(error: unknown): number | undefined {
    return error instanceof ResponseError && error.code >= 400 && error.code < 600 ? error.code : undefined;
}

/** The choices of the start screen: from the app while it is open (it has the tasks), else from the helper. */
async function startOptions() {
    if (control.hasApp()) {
        try {
            return await control.appStartOptions();
        } catch (error) {
            log(`The app did not send the start options: ${errorMessage(error)}`);
        }
    }
    return ownStarter.options();
}

/**
 * Starts an agent for the phone. While the app is open, the page starts it with the code of "Start in worktree". When
 * the app has no window (status 503), the helper starts it. After another error, the helper does not try again, because
 * the app possibly started the agent.
 */
async function startAgent(body: unknown) {
    if (!control.hasApp()) return ownStarter.start(body);
    try {
        return await control.appStartAgent(body);
    } catch (error) {
        const status = appStatus(error);
        if (status === 503) return ownStarter.start(body);
        throw new HttpError(status ?? 504, status ? errorMessage(error) : `ShipWarden on the Mac did not finish the start: ${errorMessage(error)}`);
    }
}

const remote: RemoteServer = new RemoteServer({
    devices: new RemoteDevices(join(userData, 'remote-devices.json')),
    identity: () => ensureTlsIdentity(userData),
    hosts: () => localHosts(localHostName),
    backend: {
        macName: () => computerName,
        version,
        // While the app is open, it makes the snapshot with the pull requests.
        snapshot: () =>
            control.hasApp()
                ? control.appSnapshot().catch(error => {
                      log(`The app did not send the snapshot: ${error instanceof Error ? error.message : String(error)}`);
                      return ownSnapshot.build();
                  })
                : ownSnapshot.build(),
        sessions: async () => (await sessions()).map(session => ({ ...session, ...terminalSizes.get(session.id) })),
        replay: id => terminals.replay(id),
        write: (id, data) => terminals.write(id, data),
        approvePullRequest: async (worktreePath, number, headSha, body) => {
            if (!control.hasApp()) {
                throw new HttpError(503, 'Open ShipWarden on the Mac to approve a pull request.');
            }
            await control.appApprove({ worktreePath, number, headSha, body });
        },
        pendingRuns,
        answerRun,
        startOptions,
        startAgent,
        onStatusChanged: () => control.statusChanged()
    }
});

const control = new HelperServer({
    socketPath: helperSocketPath(userData),
    buildId: hostBuildId(__filename),
    remote,
    onResize: (id, cols, rows) => {
        terminalSizes.set(id, { cols, rows });
        remote.terminalResized(id, cols, rows);
    }
});

async function stop(code: number): Promise<never> {
    shellAgents.stop();
    await automations.stop().catch(() => undefined);
    control.stop();
    await remote.stop().catch(() => undefined);
    // The PTY host and its sessions continue to run.
    terminals.dispose();
    process.exit(code);
}

// launchd sends SIGTERM when the user turns the setting off and at logout.
process.on('SIGTERM', () => void stop(0));
process.on('SIGINT', () => void stop(0));
process.on('SIGPIPE', () => undefined);
process.on('uncaughtException', error => log(`Uncaught error: ${error.stack ?? error.message}`));

async function main(): Promise<void> {
    // launchd gives a minimal PATH. git and the agents are often in folders of the login shell PATH.
    await loadLoginShellPath();
    await control.start();
    log(`Listening on ${helperSocketPath(userData)} (pid ${process.pid}, version ${version}).`);
    shellAgents.start();
    const settings = await readSettings();
    await certificates
        .apply(settings.network, loginShellCaFile())
        .catch(error => log(`The trusted certificates were not applied: ${error instanceof Error ? error.message : String(error)}`));
    networkStarted();
    automations.start();
    await remote.apply(settings.remote);
    const status = await remote.status();
    log(status.running ? `The phone server listens on port ${status.port}.` : `The phone server does not listen.${status.error ? ` ${status.error}` : ''}`);
}

main().catch(error => {
    log(`The helper did not start: ${error instanceof Error ? error.message : String(error)}`);
    // launchd starts the helper again after the throttle interval.
    process.exit(1);
});
