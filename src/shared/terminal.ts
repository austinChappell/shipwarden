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
    exited: boolean;
    exitCode?: number;
    /** The state that the agent reports through hooks. It is undefined for a shell or an agent without hooks. */
    agentState?: AgentState;
    /** A short text about the state: what the agent does now, its question, or its last message. */
    agentMessage?: string;
    /** A summary of the last prompt that the agent got. */
    agentPrompt?: string;
    /** The time of the last state change, in milliseconds. */
    agentStateAt?: number;
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
