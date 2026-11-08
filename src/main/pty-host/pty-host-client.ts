import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from 'fs';
import { connect, type Socket } from 'net';
import { dirname, join } from 'path';
import { createMessageConnection, SocketMessageReader, SocketMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';
import type { CreateTerminalOptions, TerminalReplay, TerminalSession } from '@shared/terminal';
import type { TerminalEvents } from '../terminal/terminal-manager';
import { BUILD_SOCKET_PREFIX, HostEvents, HostMethods, type AgentStateEvent, type DataEvent, type ExitEvent, type PtyHostHello } from './protocol';

const CONNECT_TIMEOUT_MS = 8000;
const CONNECT_RETRY_MS = 100;
const MAX_LOG_BYTES = 1024 * 1024;

export interface PtyHostClientOptions {
    /** The socket of the host of this build. A new host always listens on it. */
    socketPath: string;
    /**
     * Other sockets where a host of another build can listen: the socket from before the per-build sockets, and the
     * sockets from an older app name (Yardmaster). The folder of `socketPath` can contain more per-build sockets.
     */
    olderSocketPaths?: string[];
    /** The script of the host process. */
    hostScript: string;
    /** The file that gets the output of the host process. */
    logPath: string;
    events: TerminalEvents;
    /** Starts a host process. Tests replace it. */
    spawnHost?(socketPath: string, buildId: string): void;
    /** Identifies the code of the host. The default is a hash of the host script. */
    buildId?: string;
}

/** A connection to one host. */
interface HostLink {
    socketPath: string;
    connection: MessageConnection;
    pid: number;
    buildId: string;
    /** True for a host of another build. It keeps its sessions, but it gets no new sessions. */
    outdated: boolean;
    /** The sessions of the host with a running process, as far as this client knows. */
    running: Set<string>;
}

function tryConnect(socketPath: string): Promise<Socket | undefined> {
    return new Promise(resolve => {
        const socket = connect(socketPath);
        socket.once('connect', () => resolve(socket));
        socket.once('error', () => resolve(undefined));
    });
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Returns a short hash of the host script. Two builds with the same script share a host. */
export function hostBuildId(hostScript: string): string {
    try {
        return createHash('sha256').update(readFileSync(hostScript)).digest('hex').slice(0, 16);
    } catch {
        return 'unknown';
    }
}

/**
 * Connects the app to the PTY hosts. The host keeps the terminal sessions when the app quits.
 * The next app run connects to the same host.
 *
 * New sessions always go to the host of this build. It starts the host when none runs.
 * A host of another build (an outdated host) keeps its running sessions, and the app shows them.
 * When an outdated host has no running sessions, the app disconnects from it, and the host stops.
 */
export class PtyHostClient {
    private readonly links: HostLink[] = [];
    /** The host of each session. */
    private readonly owners = new Map<string, HostLink>();
    private current: HostLink | undefined;
    private opening: Promise<HostLink> | undefined;
    private discovered = false;
    private readonly buildId: string;
    private disposed = false;

    constructor(private readonly options: PtyHostClientOptions) {
        this.buildId = options.buildId ?? hostBuildId(options.hostScript);
    }

    async create(options: CreateTerminalOptions, env: NodeJS.ProcessEnv): Promise<TerminalSession> {
        const link = await this.ready();
        const cleanEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
        const session = await link.connection.sendRequest<TerminalSession>(HostMethods.create, { options, env: cleanEnv });
        this.owners.set(session.id, link);
        link.running.add(session.id);
        return session;
    }

    /** The sessions of all hosts. A session of an outdated host has `hostOutdated`. */
    async list(): Promise<TerminalSession[]> {
        await this.ready();
        const lists = await Promise.all([...this.links].map(async link => {
            try {
                const sessions = await link.connection.sendRequest<TerminalSession[]>(HostMethods.list);
                for (const session of sessions) {
                    this.owners.set(session.id, link);
                    if (!session.exited) {
                        link.running.add(session.id);
                    }
                }
                return link.outdated ? sessions.map(session => ({ ...session, hostOutdated: true })) : sessions;
            } catch {
                // The host stopped. Its connection closes and reports the exits.
                return [];
            }
        }));
        return lists.flat();
    }

    async replay(id: string): Promise<TerminalReplay> {
        const link = await this.ownerOf(id);
        return link.connection.sendRequest<TerminalReplay>(HostMethods.replay, id);
    }

    async kill(id: string): Promise<void> {
        const link = await this.ownerOf(id);
        link.running.delete(id);
        await link.connection.sendRequest(HostMethods.kill, id);
        this.owners.delete(id);
        this.releaseIfDrained(link);
    }

    /** The PIDs of the hosts. */
    async hostPids(): Promise<number[]> {
        await this.ready();
        return this.links.map(link => link.pid);
    }

    async killWorktree(worktreePath: string): Promise<void> {
        await this.ready();
        await Promise.all([...this.links].map(link => link.connection.sendRequest(HostMethods.killWorktree, worktreePath).catch(() => undefined)));
    }

    write(id: string, data: string): void {
        this.ownerOf(id).then(link => link.connection.sendNotification(HostMethods.write, id, data), () => undefined);
    }

    resize(id: string, cols: number, rows: number): void {
        this.ownerOf(id).then(link => link.connection.sendNotification(HostMethods.resize, id, cols, rows), () => undefined);
    }

    /** True when the app has a connection to a host. */
    isConnected(): boolean {
        return this.links.length > 0;
    }

    /**
     * Stops all hosts and all their sessions, and closes the connections.
     * Does nothing when no host is connected, so that it does not start a host only to stop it.
     */
    async shutdownHost(): Promise<void> {
        const links = [...this.links];
        if (links.length === 0) {
            return;
        }
        await Promise.all(links.map(link => {
            link.running.clear();
            return link.connection.sendRequest(HostMethods.shutdown).catch(() => undefined);
        }));
        this.dispose();
    }

    /**
     * Stops the outdated hosts and their sessions. The host of this build continues to run.
     * Returns the number of sessions that stopped.
     */
    async shutdownOutdatedHosts(): Promise<number> {
        const outdated = this.links.filter(link => link.outdated);
        let stopped = 0;
        await Promise.all(outdated.map(async link => {
            const running = [...link.running];
            stopped += running.length;
            link.running.clear();
            await link.connection.sendRequest(HostMethods.shutdown).catch(() => undefined);
            this.release(link);
            running.forEach(id => this.options.events.exit(id, -1));
        }));
        return stopped;
    }

    /** Closes the connections. The hosts and their sessions continue to run. */
    dispose(): void {
        this.disposed = true;
        for (const link of this.links.splice(0)) {
            link.connection.dispose();
        }
        this.owners.clear();
        this.current = undefined;
    }

    /** Returns the host of a session. A session that the client does not know goes to the host of this build. */
    private async ownerOf(id: string): Promise<HostLink> {
        const owner = this.owners.get(id);
        if (owner && this.links.includes(owner)) {
            return owner;
        }
        return this.ready();
    }

    /** Returns the host of this build. Finds the other hosts on the first call. Starts the host when none runs. */
    private ready(): Promise<HostLink> {
        if (this.disposed) {
            return Promise.reject(new Error('The PTY host connection is closed.'));
        }
        if (this.current) {
            return Promise.resolve(this.current);
        }
        this.opening ??= this.open().finally(() => {
            this.opening = undefined;
        });
        return this.opening;
    }

    private async open(): Promise<HostLink> {
        if (!this.discovered) {
            this.discovered = true;
            await this.discover();
            if (this.current) {
                return this.current;
            }
        }
        let socket = await tryConnect(this.options.socketPath);
        if (!socket) {
            (this.options.spawnHost ?? ((path, buildId) => this.spawnHost(path, buildId)))(this.options.socketPath, this.buildId);
            socket = await this.waitForHost(this.options.socketPath);
        }
        const link = await this.attach(socket, this.options.socketPath);
        if (link.outdated) {
            // Another build listens on the socket of this build. That does not occur, unless two builds have the same ID.
            console.warn(`[pty-host] The host on ${this.options.socketPath} has build ${link.buildId}, not ${this.buildId}. The app uses it.`);
            link.outdated = false;
        }
        this.current = link;
        return link;
    }

    /** Finds the hosts that run now. Uses the host of this build. Keeps an outdated host only while it has running sessions. */
    private async discover(): Promise<void> {
        const paths = [this.options.socketPath, ...this.otherBuildSockets(), ...(this.options.olderSocketPaths ?? [])];
        for (const path of [...new Set(paths)]) {
            const socket = await tryConnect(path);
            if (!socket) {
                continue;
            }
            const link = await this.attach(socket, path).catch(() => undefined);
            if (!link) {
                continue;
            }
            if (this.links.some(other => other !== link && other.pid === link.pid)) {
                // Two paths reach the same host, for example "Yardmaster" and "yardmaster" on a file system that ignores case.
                this.release(link);
                continue;
            }
            if (!link.outdated) {
                this.current ??= link;
                continue;
            }
            const sessions = await link.connection.sendRequest<TerminalSession[]>(HostMethods.list).catch(() => []);
            const running = sessions.filter(session => !session.exited);
            if (running.length === 0) {
                // The outdated host has no work. Stop it, so that only hosts of this build remain.
                console.log(`[pty-host] Stopping the host of build ${link.buildId} on ${path}. It has no running sessions.`);
                await link.connection.sendRequest(HostMethods.shutdown).catch(() => undefined);
                this.release(link);
                continue;
            }
            console.log(`[pty-host] The host of build ${link.buildId} on ${path} has ${running.length} running sessions. It keeps them. New sessions use build ${this.buildId}.`);
            sessions.forEach(session => this.owners.set(session.id, link));
            running.forEach(session => link.running.add(session.id));
        }
    }

    /** The per-build sockets of other builds in the socket folder. */
    private otherBuildSockets(): string[] {
        const folder = dirname(this.options.socketPath);
        try {
            return readdirSync(folder)
                .filter(name => name.startsWith(BUILD_SOCKET_PREFIX) && name.endsWith('.sock'))
                .map(name => join(folder, name))
                .filter(path => path !== this.options.socketPath);
        } catch {
            return [];
        }
    }

    private async waitForHost(socketPath: string): Promise<Socket> {
        const deadline = Date.now() + CONNECT_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await delay(CONNECT_RETRY_MS);
            const socket = await tryConnect(socketPath);
            if (socket) {
                return socket;
            }
        }
        throw new Error(`The terminal host did not start. See the log in ${this.options.logPath}.`);
    }

    private async attach(socket: Socket, socketPath: string): Promise<HostLink> {
        const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
        const { events } = this.options;
        // The link exists before the hello answer, so the handlers below can use it.
        const link: HostLink = { socketPath, connection, pid: 0, buildId: '', outdated: false, running: new Set() };
        connection.onNotification(HostEvents.data, ({ id, data, seq }: DataEvent) => events.data(id, data, seq));
        connection.onNotification(HostEvents.exit, ({ id, exitCode }: ExitEvent) => {
            link.running.delete(id);
            events.exit(id, exitCode);
            this.releaseIfDrained(link);
        });
        // A host of an older build sends no time, so the time of arrival stands in.
        connection.onNotification(HostEvents.agentState, ({ id, ...update }: AgentStateEvent) => events.agentState(id, { ...update, at: update.at ?? Date.now() }));
        connection.onClose(() => {
            if (!this.links.includes(link)) {
                return;
            }
            this.release(link);
            if (this.disposed) {
                return;
            }
            // The host stopped. Its sessions do not exist now.
            console.warn(`[pty-host] The connection to the terminal host on ${socketPath} closed.`);
            for (const id of link.running) {
                events.exit(id, -1);
            }
            link.running.clear();
        });
        connection.listen();
        try {
            const hello = await connection.sendRequest<PtyHostHello>(HostMethods.hello);
            link.pid = hello.pid;
            link.buildId = hello.buildId;
            link.outdated = hello.buildId !== this.buildId;
        } catch (error) {
            connection.dispose();
            throw error;
        }
        this.links.push(link);
        return link;
    }

    /** Disconnects from an outdated host that has no running sessions. With no app connected, the host stops. */
    private releaseIfDrained(link: HostLink): void {
        if (link.outdated && link.running.size === 0 && this.links.includes(link)) {
            console.log(`[pty-host] The host of build ${link.buildId} has no running sessions. The app disconnects, so the host stops.`);
            this.release(link);
        }
    }

    /** Forgets a host and closes its connection. */
    private release(link: HostLink): void {
        const index = this.links.indexOf(link);
        if (index >= 0) {
            this.links.splice(index, 1);
        }
        for (const [id, owner] of this.owners) {
            if (owner === link) {
                this.owners.delete(id);
            }
        }
        if (this.current === link) {
            this.current = undefined;
        }
        link.connection.dispose();
    }

    private spawnHost(socketPath: string, buildId: string): void {
        mkdirSync(dirname(socketPath), { recursive: true });
        let size = 0;
        try {
            size = statSync(this.options.logPath).size;
        } catch {
            // The log does not exist yet.
        }
        const log = openSync(this.options.logPath, size > MAX_LOG_BYTES ? 'w' : 'a');
        try {
            const child = spawn(process.execPath, [this.options.hostScript, socketPath, buildId], {
                detached: true,
                stdio: ['ignore', log, log],
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
            });
            child.unref();
        } finally {
            closeSync(log);
        }
    }
}
