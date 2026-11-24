/**
 * The `shipwarden` command. It sends one request to the running app through a local socket, and prints the answer.
 * The functions of this module use no Electron API. The app, the CLI, and the tests use them.
 */

/**
 * The version of the protocol between the CLI and the app.
 * Change it when a change breaks old CLI scripts or old apps.
 */
export const CLI_PROTOCOL = 1;

/** The name of the command in a shell, and of the link that Settings › Agents adds. */
export const CLI_NAME = 'shipwarden';

/** The name of the file that tells the CLI the socket path and the token. The file has mode 0600. */
export const CLI_CONFIG_NAME = 'cli.json';

/** An environment variable with the path of another config file, for example for a second app data folder. */
export const CLI_CONFIG_ENV = 'SHIPWARDEN_CLI_CONFIG';

/** The commands that the app knows. The CLI sends one of them in each request. */
export const CLI_COMMANDS = [
    'status',
    'worktree.list',
    'worktree.create',
    'worktree.remove',
    'agent.start',
    'agent.send',
    'agent.wait',
    'task.get',
    'task.status',
    'automation.list',
    'automation.run'
] as const;

export type CliCommand = (typeof CLI_COMMANDS)[number];

export function isCliCommand(value: unknown): value is CliCommand {
    return typeof value === 'string' && (CLI_COMMANDS as readonly string[]).includes(value);
}

/** The values of a request. Each command reads only the values that it knows. */
export type CliArgs = Record<string, string | number | boolean | undefined>;

/** One request of the CLI. The CLI writes it as one line of JSON, and then waits for one answer line. */
export interface CliRequest {
    protocol: number;
    token: string;
    command: CliCommand;
    args: CliArgs;
    /** The working folder of the CLI. It selects the worktree when the request has no "worktree" value. */
    cwd: string;
}

/** The error codes of an answer. The CLI uses them for its exit code. */
export type CliErrorCode = 'unauthorized' | 'badRequest' | 'notFound' | 'denied' | 'timeout' | 'failed' | 'noWindow';

/** The answer to a request. `message` is the text for a person. The other values are for `--json`. */
export type CliResponse = { ok: true; result: CliResult } | { ok: false; error: { code: CliErrorCode; message: string } };

export interface CliResult {
    message?: string;
    [key: string]: unknown;
}

/** The content of the config file. The app writes it at each start. */
export interface CliConfig {
    protocol: number;
    socket: string;
    token: string;
    /** The PID of the app that wrote the file. It helps a person who reads the file. */
    pid: number;
    version: string;
}

/** Returns a valid config, or undefined for a wrong value. */
export function parseCliConfig(value: unknown): CliConfig | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const config = value as Partial<CliConfig>;
    if (typeof config.socket !== 'string' || !config.socket || typeof config.token !== 'string' || !config.token) return undefined;
    return {
        protocol: typeof config.protocol === 'number' ? config.protocol : 0,
        socket: config.socket,
        token: config.token,
        pid: typeof config.pid === 'number' ? config.pid : 0,
        version: typeof config.version === 'string' ? config.version : ''
    };
}

/** The exit code of the CLI for an error code. 2 is a usage error, 3 is a timeout, and 4 is a missing app. */
export function exitCodeOf(code: CliErrorCode): number {
    switch (code) {
        case 'badRequest':
            return 2;
        case 'timeout':
            return 3;
        case 'noWindow':
            return 4;
        default:
            return 1;
    }
}

/**
 * A request from the main process to the page. The page owns the agent tabs, the worktree list, and the automation
 * engine, so these commands run in the page. The main process checks the values and the approval first.
 */
export type CliPageRequest =
    | { action: 'worktree.create'; repoPath: string; branch: string; baseRef?: string; agentId?: string; prompt?: string }
    | { action: 'worktree.remove'; repoPath: string; worktreePath: string; deleteBranch: boolean }
    | { action: 'agent.start'; repoPath: string; worktreePath: string; agentId?: string; prompt?: string }
    | { action: 'agent.send'; repoPath: string; worktreePath: string; prompt: string; sessionId?: string }
    | { action: 'automation.run'; automationId: string; repoPath?: string; worktreePath?: string };

/** The answer of the page. */
export interface CliPageResult {
    message: string;
    /** The worktree that the command made or used. */
    worktreePath?: string;
    branch?: string;
    /** The agent session that got the prompt or started. */
    sessionId?: string;
    agent?: string;
}

/** The state of the `shipwarden` link for Settings › Agents. */
export interface CliInstallState {
    /** The path of the link, when it exists and goes to the launcher of this app. */
    installed?: string;
    /** The launcher script in the app. */
    launcher: string;
    /** True when the folder of the link is in the PATH of the login shell. */
    inPath: boolean;
}
