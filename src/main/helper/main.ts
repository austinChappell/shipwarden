/**
 * The entry point of the background helper.
 * A macOS launch agent starts it with Electron's Node runtime (ELECTRON_RUN_AS_NODE=1), at login and after a stop.
 * It runs the phone server while ShipWarden is closed. The agents stay in the PTY host.
 * Arguments: <app data folder> <app version>.
 */
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { homedir, hostname } from 'os';
import { dirname, join, relative, resolve, isAbsolute } from 'path';
import { normalizeProjects } from '@shared/projects';
import type { TaskLink } from '@shared/tasks';
import type { TerminalSession } from '@shared/terminal';
import { ShellAgents } from '../agents/shell-agents';
import { LEGACY_NAMES } from '../legacy-migration';
import { ProcessService } from '../processes/process-service';
import { buildSocketPath, ptyHostSocketFolder, ptyHostSocketPath } from '../pty-host/protocol';
import { hostBuildId, PtyHostClient } from '../pty-host/pty-host-client';
import { RemoteDevices } from '../remote/remote-devices';
import { HttpError, localHosts, RemoteServer } from '../remote/remote-server';
import { RemoteSnapshotBuilder } from '../remote/remote-snapshot';
import { ensureTlsIdentity } from '../remote/tls-identity';
import { SettingsStore } from '../settings-store';
import { loadLoginShellPath } from '../shell-env';
import { JsonStore } from '../tasks/json-store';
import { GitWorktreeService } from '../worktrees/git-worktree-service';
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
    const settings = await new SettingsStore(join(userData, 'settings.json')).get();
    await remote.apply(settings.remote);
    const status = await remote.status();
    log(status.running ? `The phone server listens on port ${status.port}.` : `The phone server does not listen.${status.error ? ` ${status.error}` : ''}`);
}

main().catch(error => {
    log(`The helper did not start: ${error instanceof Error ? error.message : String(error)}`);
    // launchd starts the helper again after the throttle interval.
    process.exit(1);
});
