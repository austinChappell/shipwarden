import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { closeSync, openSync, readFileSync, statSync } from 'fs';
import { connect, type Socket } from 'net';
import { createMessageConnection, SocketMessageReader, SocketMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';
import type { CreateTerminalOptions, TerminalReplay, TerminalSession } from '@shared/terminal';
import type { TerminalEvents } from '../terminal/terminal-manager';
import { HostEvents, HostMethods, type AgentStateEvent, type DataEvent, type ExitEvent, type PtyHostHello } from './protocol';

const CONNECT_TIMEOUT_MS = 8000;
const CONNECT_RETRY_MS = 100;
const MAX_LOG_BYTES = 1024 * 1024;

export interface PtyHostClientOptions {
    socketPath: string;
    /**
     * Sockets of hosts from an older app name (Yardmaster). When such a host still runs, the app uses it, so its
     * terminals and agents stay visible. A new host always uses `socketPath`.
     */
    legacySocketPaths?: string[];
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
 * Connects the app to the PTY host process. It starts a host when no host runs.
 * The host keeps the terminal sessions when the app quits. The next app run connects to the same host.
 */
export class PtyHostClient {
    private connection: MessageConnection | undefined;
    private connecting: Promise<MessageConnection> | undefined;
    /** The sessions with a running process, as far as this client knows. */
    private readonly running = new Set<string>();
    private readonly buildId: string;
    private disposed = false;
    /** The socket of the host that the app reached last. */
    private reachedSocket: string;

    constructor(private readonly options: PtyHostClientOptions) {
        this.buildId = options.buildId ?? hostBuildId(options.hostScript);
        this.reachedSocket = options.socketPath;
    }

    async create(options: CreateTerminalOptions, env: NodeJS.ProcessEnv): Promise<TerminalSession> {
        const connection = await this.connect();
        const cleanEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
        const session = await connection.sendRequest<TerminalSession>(HostMethods.create, { options, env: cleanEnv });
        this.running.add(session.id);
        return session;
    }

    async list(): Promise<TerminalSession[]> {
        const sessions = await (await this.connect()).sendRequest<TerminalSession[]>(HostMethods.list);
        sessions.filter(session => !session.exited).forEach(session => this.running.add(session.id));
        return sessions;
    }

    async replay(id: string): Promise<TerminalReplay> {
        return (await this.connect()).sendRequest<TerminalReplay>(HostMethods.replay, id);
    }

    async kill(id: string): Promise<void> {
        this.running.delete(id);
        await (await this.connect()).sendRequest(HostMethods.kill, id);
    }

    /** The PID of the host process. */
    async hostPid(): Promise<number> {
        return (await (await this.connect()).sendRequest<PtyHostHello>(HostMethods.hello)).pid;
    }

    async killWorktree(worktreePath: string): Promise<void> {
        await (await this.connect()).sendRequest(HostMethods.killWorktree, worktreePath);
    }

    write(id: string, data: string): void {
        this.connect().then(connection => connection.sendNotification(HostMethods.write, id, data), () => undefined);
    }

    resize(id: string, cols: number, rows: number): void {
        this.connect().then(connection => connection.sendNotification(HostMethods.resize, id, cols, rows), () => undefined);
    }

    /** True when the app has a connection to a host. */
    isConnected(): boolean {
        return !!this.connection;
    }

    /**
     * Stops the host and all its sessions, and closes the connection.
     * Does nothing when no host is connected, so that it does not start a host only to stop it.
     */
    async shutdownHost(): Promise<void> {
        const connection = this.connection;
        if (!connection) {
            return;
        }
        this.running.clear();
        await connection.sendRequest(HostMethods.shutdown).catch(() => undefined);
        this.dispose();
    }

    /** Closes the connection. The host and its sessions continue to run. */
    dispose(): void {
        this.disposed = true;
        this.connection?.dispose();
        this.connection = undefined;
    }

    private connect(): Promise<MessageConnection> {
        if (this.disposed) {
            return Promise.reject(new Error('The PTY host connection is closed.'));
        }
        if (this.connection) {
            return Promise.resolve(this.connection);
        }
        this.connecting ??= this.open().finally(() => {
            this.connecting = undefined;
        });
        return this.connecting;
    }

    private async open(): Promise<MessageConnection> {
        let connection = await this.attach(await this.reachHost());
        const hello = await connection.sendRequest<PtyHostHello>(HostMethods.hello);
        if (hello.buildId !== this.buildId && hello.liveSessions === 0) {
            // The host comes from another build and has no work. Replace it, so the app uses its own host code.
            console.log(`[pty-host] Replacing the host of build ${hello.buildId} with build ${this.buildId}.`);
            await connection.sendRequest(HostMethods.shutdown).catch(() => undefined);
            this.detach(connection);
            await this.waitUntilGone();
            connection = await this.attach(await this.reachHost());
        } else if (hello.buildId !== this.buildId) {
            console.log(`[pty-host] The host of build ${hello.buildId} has ${hello.liveSessions} running sessions. The app uses it.`);
        }
        this.connection = connection;
        return connection;
    }

    /** Connects to the host. Starts a host when none listens. */
    private async reachHost(): Promise<Socket> {
        for (const socketPath of [this.options.socketPath, ...(this.options.legacySocketPaths ?? [])]) {
            const existing = await tryConnect(socketPath);
            if (existing) {
                this.reachedSocket = socketPath;
                return existing;
            }
        }
        this.reachedSocket = this.options.socketPath;
        (this.options.spawnHost ?? (() => this.spawnHost()))(this.options.socketPath, this.buildId);
        const deadline = Date.now() + CONNECT_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await delay(CONNECT_RETRY_MS);
            const socket = await tryConnect(this.options.socketPath);
            if (socket) {
                return socket;
            }
        }
        throw new Error(`The terminal host did not start. See the log in ${this.options.logPath}.`);
    }

    private async waitUntilGone(): Promise<void> {
        const deadline = Date.now() + CONNECT_TIMEOUT_MS;
        while (Date.now() < deadline) {
            const socket = await tryConnect(this.reachedSocket);
            if (!socket) {
                return;
            }
            socket.destroy();
            await delay(CONNECT_RETRY_MS);
        }
    }

    private attach(socket: Socket): MessageConnection {
        const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
        const { events } = this.options;
        connection.onNotification(HostEvents.data, ({ id, data, seq }: DataEvent) => events.data(id, data, seq));
        connection.onNotification(HostEvents.exit, ({ id, exitCode }: ExitEvent) => {
            this.running.delete(id);
            events.exit(id, exitCode);
        });
        // A host of an older build sends no time, so the time of arrival stands in.
        connection.onNotification(HostEvents.agentState, ({ id, ...update }: AgentStateEvent) => events.agentState(id, { ...update, at: update.at ?? Date.now() }));
        connection.onClose(() => {
            if (this.connection !== connection) {
                return;
            }
            this.connection = undefined;
            if (this.disposed) {
                return;
            }
            // The host stopped. Its sessions do not exist now.
            console.warn('[pty-host] The connection to the terminal host closed.');
            for (const id of this.running) {
                events.exit(id, -1);
            }
            this.running.clear();
        });
        connection.listen();
        return connection;
    }

    private detach(connection: MessageConnection): void {
        connection.dispose();
    }

    private spawnHost(): void {
        let size = 0;
        try {
            size = statSync(this.options.logPath).size;
        } catch {
            // The log does not exist yet.
        }
        const log = openSync(this.options.logPath, size > MAX_LOG_BYTES ? 'w' : 'a');
        try {
            const child = spawn(process.execPath, [this.options.hostScript, this.options.socketPath, this.buildId], {
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
