import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentUpdate } from '@shared/agents';
import type { CreateTerminalOptions } from '@shared/terminal';

/**
 * The version of the protocol between the app and the PTY host.
 * Change it when a change breaks old hosts or old apps. Each version has its own socket,
 * so an old host keeps its sessions and a new app starts a new host.
 */
export const PTY_HOST_PROTOCOL = 1;

/** Returns the socket path of the PTY host in a folder. Hosts before the per-build sockets use this path. */
export function ptyHostSocketPath(folder: string): string {
    return join(folder, `pty-host-v${PTY_HOST_PROTOCOL}.sock`);
}

/** The prefix of the file name of a per-build socket. */
export const BUILD_SOCKET_PREFIX = `pty-host-v${PTY_HOST_PROTOCOL}-`;

/** macOS accepts a socket path of at most 104 bytes. A longer path gets a folder in the temporary folder. */
const MAX_SOCKET_PATH_BYTES = 100;

/**
 * Returns the folder of the per-build sockets of an app data folder.
 * When a socket path in the app data folder is too long, the folder is in the temporary folder, with a hash of the app data folder.
 */
export function ptyHostSocketFolder(folder: string): string {
    const longest = join(folder, `${BUILD_SOCKET_PREFIX}${'0'.repeat(16)}.sock`);
    if (Buffer.byteLength(longest) <= MAX_SOCKET_PATH_BYTES) {
        return folder;
    }
    // A short name, so that the socket path in the temporary folder of macOS (about 50 bytes) stays below the limit.
    return join(tmpdir(), `sw-${createHash('sha256').update(folder).digest('hex').slice(0, 8)}`);
}

/**
 * Returns the socket path of the PTY host of one build. Each build has its own socket, so a new build can start
 * its host while a host of an older build still runs its sessions.
 */
export function buildSocketPath(socketFolder: string, buildId: string): string {
    return join(socketFolder, `${BUILD_SOCKET_PREFIX}${buildId}.sock`);
}

export interface PtyHostHello {
    protocol: number;
    /**
     * Identifies the code of the host. A host of another build is outdated: it keeps its running sessions, but it gets
     * no new sessions. When it has no running sessions, the app stops it.
     */
    buildId: string;
    pid: number;
    /** The number of sessions with a running process. */
    liveSessions: number;
}

export interface PtyHostCreateParams {
    options: CreateTerminalOptions;
    /** The environment of the new process. The app sends it, because the host does not have the login shell PATH of the app. */
    env: Record<string, string>;
}

/** Requests and notifications from the app to the host. */
export const HostMethods = {
    hello: 'hello',
    create: 'create',
    list: 'list',
    replay: 'replay',
    kill: 'kill',
    killWorktree: 'killWorktree',
    shutdown: 'shutdown',
    write: 'write',
    resize: 'resize'
} as const;

/** Notifications from the host to each connected app. */
export const HostEvents = {
    data: 'data',
    exit: 'exit',
    agentState: 'agentState'
} as const;

export interface DataEvent {
    id: string;
    data: string;
    seq: number;
}

export interface ExitEvent {
    id: string;
    exitCode: number;
}

export interface AgentStateEvent extends AgentUpdate {
    id: string;
}
