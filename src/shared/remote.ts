import type { AgentState } from './agents';

/**
 * The API between ShipWarden and the phone app. The phone connects to the main process over HTTPS on the local
 * network. ShipWarden makes its own certificate, and the phone pins its SHA-256 fingerprint from the pairing code.
 *
 * Change the version when a change breaks old phone apps.
 */
export const REMOTE_PROTOCOL = 1;

export const DEFAULT_REMOTE_PORT = 7429;

/** The URL scheme of the phone app. The system camera opens the app with a pairing link. */
export const PAIRING_SCHEME = 'shipwarden';

/** A pairing code is valid for this time. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** The settings of the phone connection. */
export interface RemoteSettings {
    /** True when ShipWarden accepts connections from paired phones. */
    enabled: boolean;
    port: number;
}

export const DEFAULT_REMOTE_SETTINGS: RemoteSettings = { enabled: false, port: DEFAULT_REMOTE_PORT };

export function normalizeRemoteSettings(raw: unknown): RemoteSettings {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const port = typeof value.port === 'number' && Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535
        ? value.port
        : DEFAULT_REMOTE_PORT;
    return { enabled: value.enabled === true, port };
}

/** A phone that the user paired. The token is not here. The main process keeps only a hash of it. */
export interface RemoteDevice {
    id: string;
    name: string;
    pairedAt: number;
    lastSeenAt?: number;
}

/** The state of the phone connection for the settings page. */
export interface RemoteStatus {
    enabled: boolean;
    /** True when the server listens. */
    running: boolean;
    port: number;
    /** The reason when the server does not listen, for example a port that another app uses. */
    error?: string;
    /** The SHA-256 fingerprint of the certificate, as lowercase hex without separators. */
    fingerprint?: string;
    /** The addresses that a phone can use: the .local name, then the IPv4 addresses. */
    hosts: string[];
    devices: RemoteDevice[];
    /** The IDs of the devices with an open event stream. */
    connected: string[];
}

/** The data of a pairing QR code. */
export interface PairingOffer {
    /** The pairing link. The QR code contains it. */
    link: string;
    expiresAt: number;
}

export interface PairingLink {
    /** The name of the Mac. */
    name: string;
    hosts: string[];
    port: number;
    fingerprint: string;
    code: string;
}

/** Makes the pairing link, for example `shipwarden://pair?v=1&name=Mac&h=mac.local,192.168.1.4&p=7429&fp=…&c=…`. */
export function pairingLink(link: PairingLink): string {
    const params = new URLSearchParams({
        v: String(REMOTE_PROTOCOL),
        name: link.name,
        h: link.hosts.join(','),
        p: String(link.port),
        fp: link.fingerprint,
        c: link.code
    });
    return `${PAIRING_SCHEME}://pair?${params.toString()}`;
}

/** Reads a pairing link. Returns undefined when the link is not a valid pairing link. */
export function parsePairingLink(text: string): PairingLink | undefined {
    let url: URL;
    try {
        url = new URL(text.trim());
    } catch {
        return undefined;
    }
    if (url.protocol !== `${PAIRING_SCHEME}:` || url.hostname !== 'pair') return undefined;
    const params = url.searchParams;
    const port = Number(params.get('p'));
    const hosts = (params.get('h') ?? '').split(',').map(host => host.trim()).filter(Boolean);
    const fingerprint = (params.get('fp') ?? '').toLowerCase();
    const code = params.get('c') ?? '';
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || hosts.length === 0 || !/^[0-9a-f]{64}$/.test(fingerprint) || !code) {
        return undefined;
    }
    return { name: params.get('name') ?? 'Mac', hosts, port, fingerprint, code };
}

// ---- The API data ----

export interface RemotePullRequest {
    number: number;
    title?: string;
    url: string;
    isDraft: boolean;
    reviewDecision: string | null;
    /** SUCCESS, FAILURE, ERROR, PENDING or EXPECTED. Null without checks. */
    checks: string | null;
    /** The head commit. The phone sends it with an approval, so GitHub refuses the approval of a newer commit. */
    headSha?: string;
}

export interface RemoteTask {
    title: string;
    key?: string;
    url?: string;
}

export interface RemoteWorktree {
    path: string;
    branch?: string;
    /** The display name: the name from the settings, else the branch, else the folder name. */
    name: string;
    isMain: boolean;
    task?: RemoteTask;
    pullRequest?: RemotePullRequest;
}

export interface RemoteRepo {
    path: string;
    name: string;
    /** A CSS color, for example `#4a8fe7`. */
    color?: string;
    worktrees: RemoteWorktree[];
}

export interface RemoteProject {
    id: string;
    name: string;
    repos: RemoteRepo[];
}

/** An agent session for the phone. */
export interface RemoteAgent {
    id: string;
    title: string;
    worktreePath?: string;
    cwd: string;
    state?: AgentState;
    message?: string;
    prompt?: string;
    stateAt?: number;
    exited: boolean;
}

export interface RemoteSnapshot {
    protocol: number;
    mac: { name: string; version: string };
    projects: RemoteProject[];
    agents: RemoteAgent[];
}

/**
 * A run of characters with the same style. The phone draws each line as a list of runs.
 * A color is a palette index (0–255) or an RGB value as `#rrggbb`. A missing color is the default color.
 */
export interface ScreenRun {
    t: string;
    fg?: number | string;
    bg?: number | string;
    /** Bold. */
    b?: 1;
    /** Dim. */
    d?: 1;
    /** Italic. */
    i?: 1;
    /** Underline. */
    u?: 1;
    /** Inverse: the phone swaps the foreground and the background. */
    v?: 1;
}

/** The text of a terminal: some lines of scrollback, then the visible screen. */
export interface ScreenSnapshot {
    cols: number;
    rows: number;
    /** The lines, from the oldest. The last `rows` lines are the visible screen. */
    lines: ScreenRun[][];
    /** The cursor in the visible screen, from the top left. */
    cursor: { x: number; y: number; visible: boolean };
}

/** The answer to `POST /v1/pair`. */
export interface RemotePairResponse {
    protocol: number;
    token: string;
    deviceId: string;
    mac: { name: string; version: string };
}

/** The body of each answer with an error status. */
export interface RemoteErrorBody {
    error: string;
}

/** The keys that the phone can send. */
export const REMOTE_KEYS = ['enter', 'escape', 'tab', 'shiftTab', 'up', 'down', 'left', 'right', 'backspace', 'ctrlC', 'ctrlD'] as const;
export type RemoteKey = typeof REMOTE_KEYS[number];

const KEY_BYTES: Record<RemoteKey, string> = {
    enter: '\r',
    escape: '\x1b',
    tab: '\t',
    shiftTab: '\x1b[Z',
    up: '\x1b[A',
    down: '\x1b[B',
    left: '\x1b[D',
    right: '\x1b[C',
    backspace: '\x7f',
    ctrlC: '\x03',
    ctrlD: '\x04'
};

/** Returns the bytes that a terminal gets for a key. Returns undefined for an unknown key. */
export function keyBytes(key: unknown): string | undefined {
    return typeof key === 'string' && (REMOTE_KEYS as readonly string[]).includes(key) ? KEY_BYTES[key as RemoteKey] : undefined;
}

/** The input that the phone sends to an agent: text, a key, or both. */
export interface RemoteInput {
    text?: string;
    key?: RemoteKey;
    /** True to send Enter after the text. */
    submit?: boolean;
}

/** The longest text that the phone can send at one time. */
export const MAX_INPUT_LENGTH = 16_000;

/** The terminal modes that change the bytes of the input. */
export interface InputModes {
    /** The program accepts a bracketed paste (CSI ? 2004 h). */
    bracketedPaste: boolean;
    /** The arrow keys send the application form, ESC O A (CSI ? 1 h). */
    applicationCursorKeys: boolean;
}

/**
 * Returns the writes for an input, in order. The text and Enter go in separate writes, because an agent
 * such as Claude Code takes text and Enter in one chunk as a paste. In a paste, Enter adds a new line.
 * Text with a new line goes in a bracketed paste, so the agent does not submit each line.
 */
export function inputWrites(input: RemoteInput, modes: InputModes): string[] {
    const writes: string[] = [];
    const text = typeof input.text === 'string' ? input.text.slice(0, MAX_INPUT_LENGTH) : '';
    if (text) {
        writes.push(modes.bracketedPaste && /[\r\n]/.test(text) ? `\x1b[200~${text}\x1b[201~` : text);
    }
    let key = keyBytes(input.key);
    if (key && modes.applicationCursorKeys && /^\x1b\[[ABCD]$/.test(key)) {
        key = `\x1bO${key[2]}`;
    }
    if (key) writes.push(key);
    if (input.submit) writes.push('\r');
    return writes;
}
