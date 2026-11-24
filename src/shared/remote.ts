import type { AgentState } from './agents';
import { cleanBranchName } from './branch-template';
import type { Task, TaskLink } from './tasks';
import { branchFromName } from './worktrees';

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
    /**
     * True when a background helper keeps the phone server running while ShipWarden is closed.
     * A macOS launch agent starts the helper. Off by default.
     */
    keepRunning: boolean;
}

export const DEFAULT_REMOTE_SETTINGS: RemoteSettings = { enabled: false, port: DEFAULT_REMOTE_PORT, keepRunning: false };

export function normalizeRemoteSettings(raw: unknown): RemoteSettings {
    const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const port = typeof value.port === 'number' && Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535 ? value.port : DEFAULT_REMOTE_PORT;
    return { enabled: value.enabled === true, port, keepRunning: value.keepRunning === true };
}

/** A phone that the user paired. The token is not here. The main process keeps only a hash of it. */
export interface RemoteDevice {
    id: string;
    name: string;
    pairedAt: number;
    lastSeenAt?: number;
    /** True when the phone can start agents (`POST /v1/agents/start`). A new phone cannot. Settings › Mobile turns it on. */
    canStartAgents?: boolean;
}

/** The permissions of a paired phone that the user can change in Settings › Mobile. */
export interface RemoteDevicePermissions {
    canStartAgents: boolean;
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
    /** The process that runs the server: the app, or the background helper. */
    owner?: 'app' | 'helper';
    /** The reason when the background helper is on but the app cannot use it. */
    helperError?: string;
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
    const hosts = (params.get('h') ?? '')
        .split(',')
        .map(host => host.trim())
        .filter(Boolean);
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
    /**
     * Why the agent does not work, for example "Waiting for a permission prompt" or "Waiting for CI".
     * Undefined while the agent works or starts. Older Macs do not send it.
     */
    reason?: string;
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

/**
 * A run of an automation that is waiting for the approval of the user. `GET /v1/automations/pending` gives the list.
 * The phone answers with `POST /v1/automations/runs/<id>/approve` or `/skip`.
 */
export interface RemoteAutomationRun {
    id: string;
    automationName: string;
    /** The event of the run, for example "#12 Fix the login page" or "2026-11-23 09:00". */
    label: string;
    /** The trigger of the automation, for example "ci.failed" or "schedule". */
    trigger: string;
    worktreePath?: string;
    /** The time of the run in milliseconds since 1970. */
    createdAt: number;
}

/** The answer to `GET /v1/automations/pending`. The newest run comes first. */
export interface RemotePendingRuns {
    runs: RemoteAutomationRun[];
}

/** An agent of Settings › Agents for the start screen of the phone. */
export interface RemoteAgentChoice {
    id: string;
    name: string;
    /** The model of Settings › Agents. Without it, the agent uses its own setting. */
    model?: string;
    /** True when the phone can select a model: Claude Code or Codex, and no model option in the command. */
    canSetModel: boolean;
    /** The reason when the usage budget of Settings › Agents stops this agent now, for example "Waiting for usage to reset. …". */
    budgetWait?: string;
}

/** A repository for the start screen of the phone. */
export interface RemoteRepoChoice {
    path: string;
    name: string;
    projectName: string;
    /** The agent of the repository: the agent of Settings › Repositories, else the default agent. */
    agentId: string;
}

/** A task of a task manager for the start screen of the phone. */
export interface RemoteTaskChoice {
    connectionId: string;
    id: string;
    title: string;
    key?: string;
    url?: string;
    /** The name of the status, for example "To do". */
    status?: string;
}

/** The answer to `GET /v1/start/options`: the choices of the start screen of the phone. */
export interface RemoteStartOptions {
    repos: RemoteRepoChoice[];
    agents: RemoteAgentChoice[];
    /** The open tasks of the task list that the Tasks view selected last. Empty while the app is closed. */
    tasks: RemoteTaskChoice[];
    /** Why the list has no tasks, for example "Open ShipWarden on the Mac to see the tasks." */
    tasksNote?: string;
}

/**
 * The body of `POST /v1/agents/start`. ShipWarden makes a new worktree and starts the agent in it. The agent gets
 * the task prompt (with `task`) or the prompt. Give a task or a prompt, not both.
 */
export interface RemoteStartRequest {
    repoPath: string;
    task?: { connectionId: string; id: string };
    prompt?: string;
    /** The branch of the new worktree. Without it, ShipWarden makes it from the task or the prompt. */
    branch?: string;
    /** An agent of Settings › Agents. Without it, the agent of the repository. */
    agentId?: string;
    /** The model of the new session. Without it, the model of Settings › Agents. */
    model?: string;
}

/** The answer to `POST /v1/agents/start`. The phone adds the agent and the worktree to its lists. It does not load the lists again. */
export interface RemoteStartResult {
    repoPath: string;
    worktree: RemoteWorktree;
    agent: RemoteAgent;
}

/** The longest branch name that the phone can send. */
const MAX_BRANCH_LENGTH = 200;
/** The longest model name that the phone can send. Settings › Agents uses the same limit. */
const MAX_MODEL_LENGTH = 200;

/** Reads the body of `POST /v1/agents/start`. Throws an error with a message for the phone when a value is not valid. */
export function parseStartRequest(body: unknown): RemoteStartRequest {
    const value = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const text = (key: string): string | undefined => {
        const item = value[key];
        if (item === undefined || item === null) return undefined;
        if (typeof item !== 'string') throw new Error(`The value "${key}" must be text.`);
        return item.trim() || undefined;
    };
    const repoPath = text('repoPath');
    if (!repoPath) throw new Error('Select a repository.');
    const prompt = text('prompt');
    if (prompt && prompt.length > MAX_INPUT_LENGTH) throw new Error(`The prompt is too long. Use at most ${MAX_INPUT_LENGTH} characters.`);
    const rawTask = value.task;
    let task: RemoteStartRequest['task'];
    if (rawTask !== undefined && rawTask !== null) {
        const item = rawTask as Record<string, unknown>;
        if (typeof item !== 'object' || typeof item.connectionId !== 'string' || !item.connectionId || typeof item.id !== 'string' || !item.id) {
            throw new Error('The task needs a connection and an ID.');
        }
        task = { connectionId: item.connectionId, id: item.id };
    }
    if (!task && !prompt) throw new Error('Select a task or type a prompt.');
    if (task && prompt) throw new Error('Give a task or a prompt, not both.');
    const rawBranch = text('branch');
    const branch = rawBranch ? cleanBranchName(rawBranch) : undefined;
    if (rawBranch && (!branch || rawBranch.length > MAX_BRANCH_LENGTH)) throw new Error(`"${rawBranch}" is not a valid branch name.`);
    const rawModel = text('model');
    // The same rule as a model in Settings › Agents: one word.
    const model = rawModel && rawModel.length <= MAX_MODEL_LENGTH && !/\s/.test(rawModel) ? rawModel : undefined;
    if (rawModel && !model) throw new Error('A model name is one word.');
    const agentId = text('agentId');
    return {
        repoPath,
        ...(task ? { task } : {}),
        ...(prompt ? { prompt } : {}),
        ...(branch ? { branch } : {}),
        ...(agentId ? { agentId } : {}),
        ...(model ? { model } : {})
    };
}

/** The phone shows at most this number of tasks. */
const MAX_PHONE_TASKS = 100;

/** Returns the tasks that the phone can start: the open tasks without a worktree, from the list that the Tasks view selected last. */
export function openTaskChoices(connectionId: string, tasks: readonly Task[], links: Record<string, TaskLink>): RemoteTaskChoice[] {
    const linked = new Set(
        Object.values(links)
            .filter(link => (link.connectionId ?? link.pluginId) === connectionId)
            .map(link => link.taskId)
    );
    return tasks
        .filter(task => task.status.category !== 'done' && task.status.category !== 'canceled' && !linked.has(task.id))
        .slice(0, MAX_PHONE_TASKS)
        .map(task => ({
            connectionId,
            id: task.id,
            title: task.title,
            ...(task.key ? { key: task.key } : {}),
            ...(task.url ? { url: task.url } : {}),
            status: task.status.name
        }));
}

/** The number of words of the prompt in the branch name of a start from the phone. */
const BRANCH_WORDS = 6;

/** Makes the branch of a prompt from the phone, for example "fix-the-login-page" for "Fix the login page, please". */
export function promptBranchName(prompt: string, now = Date.now()): string {
    const words = prompt.split(/\s+/).filter(Boolean).slice(0, BRANCH_WORDS).join(' ');
    return branchFromName(words) || `phone-${new Date(now).toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
}

/** The body of each answer with an error status. */
export interface RemoteErrorBody {
    error: string;
}

/** The keys that the phone can send. */
export const REMOTE_KEYS = ['enter', 'escape', 'tab', 'shiftTab', 'up', 'down', 'left', 'right', 'backspace', 'ctrlC', 'ctrlD'] as const;
export type RemoteKey = (typeof REMOTE_KEYS)[number];

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
