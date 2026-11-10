import { chmodSync, mkdirSync, unlinkSync } from 'fs';
import { connect, createServer, type Server, type Socket } from 'net';
import { dirname } from 'path';
import { createMessageConnection, SocketMessageReader, SocketMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';
import { normalizeRemoteSettings, type RemoteSnapshot } from '@shared/remote';
import type { RemoteServer } from '../remote/remote-server';
import { AppMethods, HELPER_PROTOCOL, HelperMethods, type ApproveParams, type HelperHello } from './protocol';

/** The app does not answer a request in this time. The helper then uses its own data. */
const APP_TIMEOUT_MS = 20_000;

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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The app did not answer.')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface HelperServerOptions {
    socketPath: string;
    buildId: string;
    remote: RemoteServer;
    /** Receives the terminal size that the page sent. */
    onResize(id: string, cols: number, rows: number): void;
}

/**
 * The control socket of the background helper. The app connects to it, sends the phone settings and the requests of
 * the settings page, and answers the requests that need the app (the pull requests).
 * The socket file has mode 0600, so only the user can connect. This is the same as the PTY host socket.
 */
export class HelperServer {
    private server: Server | undefined;
    /** The connected apps. The last one answers the requests of the helper. */
    private readonly apps: MessageConnection[] = [];

    constructor(private readonly options: HelperServerOptions) {}

    async start(): Promise<void> {
        const { socketPath } = this.options;
        if (await socketIsLive(socketPath)) {
            throw new Error(`Another helper listens on ${socketPath}.`);
        }
        try {
            unlinkSync(socketPath);
        } catch {
            // There was no socket file.
        }
        mkdirSync(dirname(socketPath), { recursive: true });
        await new Promise<void>((resolve, reject) => {
            const server = createServer(socket => this.accept(socket));
            server.once('error', reject);
            server.listen(socketPath, () => {
                chmodSync(socketPath, 0o600);
                this.server = server;
                resolve();
            });
        });
    }

    stop(): void {
        this.apps.splice(0).forEach(app => app.dispose());
        this.server?.close();
        this.server = undefined;
        try {
            unlinkSync(this.options.socketPath);
        } catch {
            // The socket file is already removed.
        }
    }

    /** True when an app is connected. */
    hasApp(): boolean {
        return this.apps.length > 0;
    }

    /** Asks the app for the full snapshot. Rejects when no app is connected or the app does not answer. */
    async appSnapshot(): Promise<Omit<RemoteSnapshot, 'protocol' | 'mac'>> {
        const app = this.apps.at(-1);
        if (!app) throw new Error('ShipWarden is not open.');
        return withTimeout(app.sendRequest<Omit<RemoteSnapshot, 'protocol' | 'mac'>>(AppMethods.snapshot), APP_TIMEOUT_MS);
    }

    /** Asks the app to approve a pull request. Rejects when no app is connected. */
    async appApprove(params: ApproveParams): Promise<void> {
        const app = this.apps.at(-1);
        if (!app) throw new Error('ShipWarden is not open.');
        await withTimeout(app.sendRequest(AppMethods.approvePullRequest, params), APP_TIMEOUT_MS);
    }

    /** Tells the apps that the devices or the phone connections changed. */
    statusChanged(): void {
        for (const app of this.apps) void app.sendNotification(AppMethods.statusChanged).catch(() => undefined);
    }

    private accept(socket: Socket): void {
        const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
        const { remote } = this.options;
        this.apps.push(connection);
        connection.onRequest(HelperMethods.hello, (): HelperHello => ({ protocol: HELPER_PROTOCOL, buildId: this.options.buildId, pid: process.pid }));
        connection.onRequest(HelperMethods.apply, (settings: unknown) => remote.apply(normalizeRemoteSettings(settings)));
        connection.onRequest(HelperMethods.status, () => remote.status());
        connection.onRequest(HelperMethods.startPairing, () => remote.startPairing());
        connection.onRequest(HelperMethods.cancelPairing, () => remote.cancelPairing());
        connection.onRequest(HelperMethods.removeDevice, (id: unknown) => remote.removeDevice(String(id)));
        connection.onNotification(HelperMethods.terminalResized, (id: unknown, cols: unknown, rows: unknown) => {
            if (Number(cols) > 0 && Number(rows) > 0) this.options.onResize(String(id), Number(cols), Number(rows));
        });
        const remove = () => {
            const index = this.apps.indexOf(connection);
            if (index >= 0) {
                this.apps.splice(index, 1);
                connection.dispose();
            }
        };
        connection.onClose(remove);
        connection.onError(() => remove());
        socket.on('close', remove);
        connection.listen();
    }
}
