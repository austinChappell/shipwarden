import { connect, type Socket } from 'net';
import { createMessageConnection, SocketMessageReader, SocketMessageWriter } from 'vscode-jsonrpc/node';
import type { PairingOffer, RemoteSettings, RemoteSnapshot, RemoteStatus } from '@shared/remote';
import { AppMethods, HelperMethods, type ApproveParams, type HelperHello } from './protocol';

/** The app's connection to the background helper. */
export interface HelperConnection {
    hello(): Promise<HelperHello>;
    apply(settings: RemoteSettings): Promise<void>;
    status(): Promise<RemoteStatus>;
    startPairing(): Promise<PairingOffer>;
    cancelPairing(): Promise<void>;
    removeDevice(id: string): Promise<void>;
    terminalResized(id: string, cols: number, rows: number): void;
    onClose(listener: () => void): void;
    /** Closes the connection. The helper continues to run. */
    close(): void;
}

/** The requests of the helper that the app answers. */
export interface HelperRequests {
    snapshot(): Promise<Omit<RemoteSnapshot, 'protocol' | 'mac'>>;
    approvePullRequest(params: ApproveParams): Promise<void>;
    statusChanged(): void;
}

function tryConnect(socketPath: string): Promise<Socket | undefined> {
    return new Promise(resolve => {
        const socket = connect(socketPath);
        socket.once('connect', () => resolve(socket));
        socket.once('error', () => resolve(undefined));
    });
}

/** Connects to the helper socket. Returns undefined when no helper listens. */
export async function connectHelper(socketPath: string, requests: HelperRequests): Promise<HelperConnection | undefined> {
    const socket = await tryConnect(socketPath);
    if (!socket) return undefined;
    const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
    connection.onRequest(AppMethods.snapshot, () => requests.snapshot());
    connection.onRequest(AppMethods.approvePullRequest, (params: ApproveParams) => requests.approvePullRequest(params));
    connection.onNotification(AppMethods.statusChanged, () => requests.statusChanged());
    const listeners: (() => void)[] = [];
    let closed = false;
    const closeOnce = () => {
        if (closed) return;
        closed = true;
        connection.dispose();
        socket.destroy();
        listeners.forEach(listener => listener());
    };
    connection.onClose(closeOnce);
    connection.onError(closeOnce);
    socket.on('close', closeOnce);
    connection.listen();
    return {
        hello: () => connection.sendRequest<HelperHello>(HelperMethods.hello),
        apply: settings => connection.sendRequest(HelperMethods.apply, settings),
        status: () => connection.sendRequest<RemoteStatus>(HelperMethods.status),
        startPairing: () => connection.sendRequest<PairingOffer>(HelperMethods.startPairing),
        cancelPairing: () => connection.sendRequest(HelperMethods.cancelPairing),
        removeDevice: id => connection.sendRequest(HelperMethods.removeDevice, id),
        terminalResized: (id, cols, rows) => void connection.sendNotification(HelperMethods.terminalResized, id, cols, rows).catch(() => undefined),
        onClose: listener => listeners.push(listener),
        close: closeOnce
    };
}
