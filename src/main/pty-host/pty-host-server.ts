import { chmodSync, unlinkSync } from 'fs';
import { connect, createServer, type Server, type Socket } from 'net';
import { createMessageConnection, SocketMessageReader, SocketMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';
import { agentStateFromHook } from '@shared/agents';
import type { CreateTerminalOptions } from '@shared/terminal';
import { HookServer } from '../agents/hook-server';
import { TerminalManager } from '../terminal/terminal-manager';
import { HostEvents, HostMethods, PTY_HOST_PROTOCOL, type PtyHostCreateParams, type PtyHostHello } from './protocol';

export interface PtyHostServerOptions {
    socketPath: string;
    buildId: string;
    /** The time that the host waits with no app and no running session before it calls `onIdle`. */
    idleMs?: number;
    /** The time that a new host waits for the first app. The app that started the host connects in this time. */
    startupGraceMs?: number;
    /** Called when the host has nothing to do, or when an app asks it to stop. The host process then exits. */
    onIdle(reason: string): void;
}

/** Returns true when a process listens on the socket. */
function socketIsLive(socketPath: string): Promise<boolean> {
    return new Promise(resolve => {
        const socket = connect(socketPath);
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
    });
}

/**
 * The server of the PTY host. It keeps the terminal processes and the agent hook server
 * in a process that is not the app, so agents continue to run when the app quits.
 * Each app connects through a Unix socket and gets the events of all sessions.
 */
export class PtyHostServer {
    private readonly clients = new Set<MessageConnection>();
    private readonly terminals: TerminalManager;
    private readonly hookServer: HookServer;
    private server: Server | undefined;
    private idleTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly options: PtyHostServerOptions) {
        this.terminals = new TerminalManager({
            data: (id, data, seq) => this.broadcast(HostEvents.data, { id, data, seq }),
            exit: (id, exitCode) => {
                this.broadcast(HostEvents.exit, { id, exitCode });
                this.checkIdle();
            },
            agentState: (id, update) => this.broadcast(HostEvents.agentState, { id, ...update })
        });
        this.hookServer = new HookServer((sessionId, event, payload) => {
            if (event === 'Notification') {
                // The fields of a notification decide between "needs input" and "idle". The log helps when an agent version changes them.
                console.log(`[agents] Notification for ${sessionId}: type=${String(payload.notification_type)} message=${String(payload.message)}`);
            }
            const change = agentStateFromHook(event, payload, this.terminals.agentState(sessionId));
            if (change) {
                this.terminals.setAgentState(sessionId, change);
            }
        });
    }

    /**
     * Starts the hook server and listens on the socket.
     * Throws an error when another host already listens on the socket.
     */
    async start(): Promise<void> {
        if (await socketIsLive(this.options.socketPath)) {
            throw new Error(`Another PTY host listens on ${this.options.socketPath}.`);
        }
        try {
            // A host that stopped without cleanup leaves its socket file.
            unlinkSync(this.options.socketPath);
        } catch {
            // There was no socket file.
        }
        try {
            this.terminals.setHookEnvironment(await this.hookServer.start());
        } catch (error) {
            // Without the hook server, agents still run. ShipWarden then shows no agent state.
            console.warn(`[agents] The hook server did not start: ${error instanceof Error ? error.message : String(error)}`);
        }
        await new Promise<void>((resolve, reject) => {
            const server = createServer(socket => this.accept(socket));
            server.once('error', reject);
            server.listen(this.options.socketPath, () => {
                chmodSync(this.options.socketPath, 0o600);
                this.server = server;
                resolve();
            });
        });
        this.checkIdle(this.options.startupGraceMs ?? 30_000);
    }

    /** Stops all sessions and closes the socket. */
    stop(): void {
        clearTimeout(this.idleTimer);
        this.terminals.killAll();
        this.hookServer.stop();
        this.clients.forEach(client => client.dispose());
        this.clients.clear();
        this.server?.close();
        this.server = undefined;
    }

    private accept(socket: Socket): void {
        const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
        this.clients.add(connection);
        clearTimeout(this.idleTimer);

        connection.onRequest(
            HostMethods.hello,
            (): PtyHostHello => ({
                protocol: PTY_HOST_PROTOCOL,
                buildId: this.options.buildId,
                pid: process.pid,
                liveSessions: this.terminals.liveCount()
            })
        );
        connection.onRequest(HostMethods.create, ({ options, env }: PtyHostCreateParams) => this.terminals.create(options as CreateTerminalOptions, env));
        connection.onRequest(HostMethods.list, () => this.terminals.list());
        connection.onRequest(HostMethods.replay, (id: string) => this.terminals.replay(id));
        connection.onRequest(HostMethods.kill, (id: string) => {
            this.terminals.kill(id);
            this.checkIdle();
        });
        connection.onRequest(HostMethods.killWorktree, (worktreePath: string) => {
            this.terminals.killWorktree(worktreePath);
            this.checkIdle();
        });
        connection.onRequest(HostMethods.shutdown, () => {
            // Answer first. Then stop, so the app gets the answer.
            setTimeout(() => this.options.onIdle(`An app asked the host to stop. ${this.terminals.liveCount()} running sessions stop.`), 50);
        });
        connection.onNotification(HostMethods.write, (id: string, data: string) => this.terminals.write(id, data));
        connection.onNotification(HostMethods.resize, (id: string, cols: number, rows: number) => this.terminals.resize(id, cols, rows));

        const remove = () => {
            if (this.clients.delete(connection)) {
                connection.dispose();
                this.checkIdle();
            }
        };
        connection.onClose(remove);
        connection.onError(() => remove());
        socket.on('close', remove);
        connection.listen();
    }

    private broadcast(method: string, params: object): void {
        for (const client of this.clients) {
            client.sendNotification(method, params).catch(() => undefined);
        }
    }

    /** Starts the idle timer when no app is connected and no session has a running process. */
    private checkIdle(delayMs = this.options.idleMs ?? 10_000): void {
        clearTimeout(this.idleTimer);
        if (this.clients.size > 0 || this.terminals.liveCount() > 0) {
            return;
        }
        this.idleTimer = setTimeout(() => this.options.onIdle('No app is connected and no session runs.'), delayMs);
    }
}
