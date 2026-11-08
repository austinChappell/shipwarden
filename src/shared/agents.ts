/**
 * The state of an agent in a terminal session.
 * - starting: the process started, but the agent did not report yet.
 * - idle: the agent is ready and has no prompt yet.
 * - working: the agent works on a prompt.
 * - waiting: the agent needs the user, for example a permission or an answer.
 * - done: the agent finished its turn and waits for the next prompt.
 * - exited: the agent session ended.
 */
export type AgentState = 'starting' | 'idle' | 'working' | 'waiting' | 'done' | 'exited';

export const AGENT_STATE_LABELS: Record<AgentState, string> = {
    starting: 'Starting',
    idle: 'Ready',
    working: 'Working',
    waiting: 'Needs input',
    done: 'Done',
    exited: 'Exited'
};

/** The order of importance of the states in the worktree list. The first state needs the user most. */
const STATE_PRIORITY: AgentState[] = ['waiting', 'working', 'done', 'starting', 'idle', 'exited'];

/**
 * Returns the state that a worktree row shows when the worktree has several agent sessions.
 * An agent that needs the user wins over an agent that works, and so on.
 */
export function worktreeAgentState(states: readonly (AgentState | undefined)[]): AgentState | undefined {
    const present = states.filter((state): state is AgentState => !!state);
    return present.sort((a, b) => STATE_PRIORITY.indexOf(a) - STATE_PRIORITY.indexOf(b))[0];
}

/** The Claude Code hook events that ShipWarden listens to. */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd'] as const;
export type HookEvent = typeof HOOK_EVENTS[number];

export interface AgentStateChange {
    state: AgentState;
    /**
     * A short text for the UI and for notifications: what the agent does now (for example "Editing App.tsx"),
     * the question that it asks, or its last message.
     */
    message?: string;
    /** A summary of the prompt that the agent works on. Only a prompt event sets it. */
    prompt?: string;
}

/** A change of an agent's state, as the PTY host sends it to the app. */
export interface AgentUpdate extends AgentStateChange {
    /** The time of the change, in milliseconds. */
    at: number;
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Shortens a text to one line of at most `max` characters. */
export function oneLine(value: string, max = 80): string {
    const line = value.replace(/\s+/g, ' ').trim();
    return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function fileName(path: unknown): string | undefined {
    const value = text(path);
    return value ? value.split('/').filter(Boolean).pop() : undefined;
}

/**
 * Describes a tool call of Claude Code for people, for example "Editing App.tsx" or "Running npm test".
 * `input` is the tool input from the PreToolUse hook.
 */
export function describeTool(tool: string, input: Record<string, unknown> = {}): string {
    switch (tool) {
        case 'Bash': {
            const description = text(input.description);
            return description ? oneLine(description, 70) : `Running ${oneLine(text(input.command) ?? 'a command', 60)}`;
        }
        case 'Edit':
        case 'MultiEdit':
        case 'Write':
        case 'NotebookEdit':
            return `Editing ${fileName(input.file_path ?? input.notebook_path) ?? 'a file'}`;
        case 'Read':
            return `Reading ${fileName(input.file_path) ?? 'a file'}`;
        case 'Grep':
            return text(input.pattern) ? `Searching for "${oneLine(text(input.pattern)!, 40)}"` : 'Searching the code';
        case 'Glob':
            return text(input.pattern) ? `Finding files ${oneLine(text(input.pattern)!, 40)}` : 'Finding files';
        case 'WebFetch': {
            try {
                return `Reading ${new URL(String(input.url)).host}`;
            } catch {
                return 'Reading a web page';
            }
        }
        case 'WebSearch':
            return text(input.query) ? `Searching the web for "${oneLine(text(input.query)!, 40)}"` : 'Searching the web';
        case 'Task':
        case 'Agent':
            return text(input.description) ? `Running a subagent: ${oneLine(text(input.description)!, 50)}` : 'Running a subagent';
        case 'TodoWrite':
            return 'Updating its to-do list';
        default: {
            // MCP tools are "mcp__<server>__<tool>".
            const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
            return mcp ? `Using ${mcp[2].replace(/_/g, ' ')} (${mcp[1]})` : `Using ${tool}`;
        }
    }
}

/**
 * Converts a Claude Code hook event to an agent state.
 * `current` is the state before the event. Returns undefined for an event that does not change the state.
 */
export function agentStateFromHook(event: string, payload: Record<string, unknown>, current?: AgentState): AgentStateChange | undefined {
    switch (event) {
        case 'SessionStart':
            return { state: 'idle' };
        case 'UserPromptSubmit': {
            const prompt = text(payload.prompt);
            return { state: 'working', message: 'Reading your prompt', ...(prompt ? { prompt: oneLine(prompt, 120) } : {}) };
        }
        case 'PreToolUse':
            // A tool call after a permission prompt means that the user answered, so the agent works again.
            return {
                state: 'working',
                message: describeTool(String(payload.tool_name ?? 'a tool'), (payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}) as Record<string, unknown>)
            };
        case 'Notification': {
            const type = payload.notification_type;
            // Claude Code sends "idle_prompt" about 60 seconds after a turn ends. It is not a question, so "done" stays.
            if (type === 'idle_prompt' && (current === 'done' || current === 'idle')) {
                return undefined;
            }
            // "auth_success" only reports a login.
            if (type === 'auth_success') {
                return undefined;
            }
            // Other types, for example "permission_prompt", wait for the user.
            return { state: 'waiting', message: text(payload.message) ?? 'The agent needs your input.' };
        }
        case 'Stop':
            return { state: 'done', message: text(payload.last_assistant_message) };
        case 'SessionEnd':
            return { state: 'exited' };
        default:
            return undefined;
    }
}

/**
 * Returns the hook settings that ShipWarden gives to Claude Code with --settings.
 * Each hook sends the event JSON (on stdin) to ShipWarden's hook server. The environment of the
 * terminal supplies the URL, the token and the session ID, so one settings file serves all sessions.
 * A failed request must not block the agent, so the command always succeeds.
 * A PTY host from the time when the app was Yardmaster sets YARDMASTER_* variables and reads the X-Yardmaster-Token
 * header. The command uses those when the new variables are not set, so agents of an old host also report their state.
 */
export function claudeHookSettings(): { hooks: Record<string, unknown[]> } {
    const hooks: Record<string, unknown[]> = {};
    for (const event of HOOK_EVENTS) {
        const token = '${SHIPWARDEN_HOOK_TOKEN:-$YARDMASTER_HOOK_TOKEN}';
        const command = `curl -s -m 2 -o /dev/null -X POST -H "X-ShipWarden-Token: ${token}" -H "X-Yardmaster-Token: ${token}" `
            + `--data-binary @- "\${SHIPWARDEN_HOOK_URL:-$YARDMASTER_HOOK_URL}/hook/\${SHIPWARDEN_SESSION_ID:-$YARDMASTER_SESSION_ID}/${event}" || true`;
        hooks[event] = [{ ...(event === 'PreToolUse' ? { matcher: '*' } : {}), hooks: [{ type: 'command', command, timeout: 5 }] }];
    }
    return { hooks };
}

/** Quotes a value for a POSIX shell. */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Adds ShipWarden's hook settings to an agent command when the agent is Claude Code.
 * Other agents keep their command, and ShipWarden shows no detailed state for them.
 */
export function withAgentHooks(command: string, settingsPath: string): string {
    const program = command.trim().split(/\s+/)[0];
    if (program !== 'claude' && !program.endsWith('/claude')) {
        return command;
    }
    return `${command.trim()} --settings ${shellQuote(settingsPath)}`;
}
