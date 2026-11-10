import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The version of the protocol between the app and the background helper.
 * Change it when a change breaks old helpers or old apps.
 */
export const HELPER_PROTOCOL = 1;

/** The launchd label of the background helper. The plist file has this name. */
export const HELPER_LABEL = 'dev.shipwarden.helper';

/** macOS accepts a socket path of at most 104 bytes. */
const MAX_SOCKET_PATH_BYTES = 100;

/**
 * Returns the socket path of the background helper for an app data folder.
 * When the path is too long, the socket is in the temporary folder, with a hash of the app data folder.
 */
export function helperSocketPath(folder: string): string {
    const name = `helper-v${HELPER_PROTOCOL}.sock`;
    const path = join(folder, name);
    if (Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES) {
        return path;
    }
    return join(tmpdir(), `sw-${createHash('sha256').update(folder).digest('hex').slice(0, 8)}`, name);
}

export interface HelperHello {
    protocol: number;
    /** A hash of the helper script. A different value means that the helper runs an older build. */
    buildId: string;
    pid: number;
}

/** Requests and notifications from the app to the helper. */
export const HelperMethods = {
    hello: 'hello',
    /** Sends the phone settings. The helper starts, restarts or stops the server. */
    apply: 'apply',
    status: 'status',
    startPairing: 'startPairing',
    cancelPairing: 'cancelPairing',
    removeDevice: 'removeDevice',
    /** Notification: the page changed the size of a terminal. */
    terminalResized: 'terminalResized'
} as const;

/** Requests and notifications from the helper to the app. */
export const AppMethods = {
    /** The full phone snapshot, with the pull requests. Only the app can read GitHub and Azure DevOps. */
    snapshot: 'snapshot',
    approvePullRequest: 'approvePullRequest',
    /** Notification: the devices or the phone connections changed. */
    statusChanged: 'statusChanged'
} as const;

export interface ApproveParams {
    worktreePath: string;
    number: number;
    headSha: string;
    body: string;
}
