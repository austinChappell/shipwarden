import { connect, type Socket } from 'net';
import { createMessageConnection, ResponseError, SocketMessageReader, SocketMessageWriter } from 'vscode-jsonrpc/node';
import type {
    PairingOffer,
    RemoteDevicePermissions,
    RemoteSettings,
    RemoteSnapshot,
    RemoteStartOptions,
    RemoteStartResult,
    RemoteStatus
} from '@shared/remote';
import { HttpError } from '../remote/remote-server';
import { AppMethods, HelperMethods, type AnswerRunParams, type ApproveParams, type HelperHello } from './protocol';

/** The app's connection to the background helper. */
export interface HelperConnection {
    hello(): Promise<HelperHello>;
    apply(settings: RemoteSettings): Promise<void>;
    status(): Promise<RemoteStatus>;
    startPairing(): Promise<PairingOffer>;
    cancelPairing(): Promise<void>;
    removeDevice(id: string): Promise<void>;
    setDevicePermissions(id: string, permissions: RemoteDevicePermissions): Promise<void>;
    terminalResized(id: string, cols: number, rows: number): void;
    onClose(listener: () => void): void;
    /** Closes the connection. The helper continues to run. */
    close(): void;
}

/** The requests of the helper that the app answers. */
export interface HelperRequests {
    snapshot(): Promise<Omit<RemoteSnapshot, 'protocol' | 'mac'>>;
    approvePullRequest(params: ApproveParams): Promise<void>;
    answerRun(params: AnswerRunParams): Promise<void>;
    startOptions(): Promise<RemoteStartOptions>;
    startAgent(body: unknown): Promise<RemoteStartResult>;
    statusChanged(): void;
}

/** Sends the HTTP status of an `HttpError` to the helper as the error code, so the helper can send it to the phone. */
async function withStatus<T>(work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch (error) {
        if (error instanceof HttpError) throw new ResponseError(error.status, error.message);
        throw error;
    }
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
    connection.onRequest(AppMethods.answerRun, (params: AnswerRunParams) => requests.answerRun(params));
    connection.onRequest(AppMethods.startOptions, () => withStatus(() => requests.startOptions()));
    connection.onRequest(AppMethods.startAgent, (body: unknown) => withStatus(() => requests.startAgent(body)));
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
        setDevicePermissions: (id, permissions) => connection.sendRequest(HelperMethods.setDevicePermissions, { id, permissions }),
        terminalResized: (id, cols, rows) => void connection.sendNotification(HelperMethods.terminalResized, id, cols, rows).catch(() => undefined),
        onClose: listener => listeners.push(listener),
        close: closeOnce
    };
}
