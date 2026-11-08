import { join } from 'path';
import type { AgentUpdate } from '@shared/agents';
import type { CreateTerminalOptions } from '@shared/terminal';

/**
 * The version of the protocol between the app and the PTY host.
 * Change it when a change breaks old hosts or old apps. Each version has its own socket,
 * so an old host keeps its sessions and a new app starts a new host.
 */
export const PTY_HOST_PROTOCOL = 1;

/** Returns the socket path of the PTY host in a folder. */
export function ptyHostSocketPath(folder: string): string {
    return join(folder, `pty-host-v${PTY_HOST_PROTOCOL}.sock`);
}

export interface PtyHostHello {
    protocol: number;
    /** Identifies the code of the host. The app replaces a host from another build when the host has no running sessions. */
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
