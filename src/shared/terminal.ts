/** The colors of a terminal. The names are the same as in xterm.js and ghostty-web. */
export interface TerminalColors {
    foreground?: string;
    background?: string;
    cursor?: string;
    cursorAccent?: string;
    selectionBackground?: string;
    selectionForeground?: string;
    black?: string;
    red?: string;
    green?: string;
    yellow?: string;
    blue?: string;
    magenta?: string;
    cyan?: string;
    white?: string;
    brightBlack?: string;
    brightRed?: string;
    brightGreen?: string;
    brightYellow?: string;
    brightBlue?: string;
    brightMagenta?: string;
    brightCyan?: string;
    brightWhite?: string;
}

/** A key chord that sends text to the terminal. Ghostty writes this as `keybind = shift+enter=text:\n`. */
export interface TextKeybind {
    key: string;
    shift: boolean;
    ctrl: boolean;
    alt: boolean;
    meta: boolean;
    /** The text to send. Escape sequences are already decoded. */
    text: string;
}

export interface TerminalSettings {
    fontFamily: string;
    fontSize: number;
    cursorStyle: 'block' | 'underline' | 'bar';
    cursorBlink: boolean;
    colors: TerminalColors;
    keybinds: TextKeybind[];
    /** The file or command that supplied the settings. It is undefined when ShipWarden uses its defaults. */
    source?: string;
}

import type { AgentProgram } from './agent-programs';
import type { AgentState } from './agents';

/** A terminal process in the main process. */
export interface TerminalSession {
    id: string;
    title: string;
    cwd: string;
    /** The worktree path that owns the session, if any. */
    worktreePath?: string;
    /** True when the session runs an agent. */
    isAgent: boolean;
    /** The PID of the shell. Sessions of an older PTY host do not have it. */
    pid?: number;
    /** The size of the terminal in characters. Sessions of an older PTY host do not have it. */
    cols?: number;
    rows?: number;
    exited: boolean;
    exitCode?: number;
    /**
     * The time of the last input or output, in milliseconds. Sessions of an older PTY host do not have it.
     * The app uses it to find stale shells.
     */
    lastActiveAt?: number;
    /** The state that the agent reports through hooks. It is undefined for a shell or an agent without hooks. */
    agentState?: AgentState;
    /** A short text about the state: what the agent does now, its question, or its last message. */
    agentMessage?: string;
    /** A summary of the last prompt that the agent got. */
    agentPrompt?: string;
    /** The transcript file of a Claude Code session, from its hooks. */
    agentTranscript?: string;
    /** The time of the last state change, in milliseconds. */
    agentStateAt?: number;
    /** The agent program that runs in a shell tab, for example `claude` that the user typed. The app finds it in the process table. */
    agentProgram?: AgentProgram;
    /**
     * True when the session runs in a PTY host of an older build. Such a host keeps its sessions, but it does not get
     * new sessions. Features of newer builds can be missing in it, for example the hooks of an agent in a shell tab.
     */
    hostOutdated?: boolean;
}

/**
 * Returns true when the session runs an agent: an agent tab, or a shell tab in which an agent runs
 * (for example `claude` or `codex` that the user typed). The app finds such an agent in the process table,
 * or the agent reports its state through the hooks.
 */
export function runsAgent(session: Pick<TerminalSession, 'isAgent' | 'exited' | 'agentState' | 'agentProgram'>): boolean {
    if (session.exited) {
        return false;
    }
    return session.isAgent || !!session.agentProgram || (!!session.agentState && session.agentState !== 'exited');
}

/** Returns true when the session is a shell tab that runs and has no agent in it. */
export function isOpenShell(session: Pick<TerminalSession, 'isAgent' | 'exited' | 'agentState' | 'agentProgram'>): boolean {
    return !session.exited && !runsAgent(session);
}

/** Returns the number of open shell tabs of a worktree. */
export function openShellCount(sessions: readonly TerminalSession[], worktreePath: string): number {
    return sessions.filter(session => session.worktreePath === worktreePath && isOpenShell(session)).length;
}

/** A shell with no input and no output for this time is stale. The app can close it (Settings › Worktrees). */
export const STALE_SHELL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Returns true when the session is a stale shell: a shell tab of a worktree with no input and no output for `STALE_SHELL_MS`.
 * A session without `lastActiveAt` (from an older PTY host) is never stale.
 */
export function isStaleShell(session: TerminalSession, now: number): boolean {
    return !!session.worktreePath && isOpenShell(session) && session.lastActiveAt !== undefined && now - session.lastActiveAt >= STALE_SHELL_MS;
}

export interface CreateTerminalOptions {
    cwd: string;
    title: string;
    cols: number;
    rows: number;
    worktreePath?: string;
    /** A command to run in an interactive login shell, for example `claude`. When the command exits, a normal shell starts. */
    command?: string;
    isAgent?: boolean;
    /**
     * True when the agent reports its state through ShipWarden's hooks (Claude Code).
     * The main process sets it. Other agents get no state, so they do not show "Starting" for ever.
     */
    reportsAgentState?: boolean;
}

/** The recent output of a session. */
export interface TerminalReplay {
    data: string;
    /** The sequence number of the last chunk in `data`. A view ignores live chunks with a sequence number that is not larger. */
    seq: number;
}
