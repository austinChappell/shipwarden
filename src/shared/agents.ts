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
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * The Gemini CLI hook events that ShipWarden listens to.
 * BeforeAgent is the prompt, BeforeTool and AfterTool are tool calls, AfterAgent is the end of a turn.
 * Gemini CLI uses the same names as Claude Code for SessionStart, Notification and SessionEnd.
 */
export const GEMINI_HOOK_EVENTS = ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'Notification', 'AfterAgent', 'SessionEnd'] as const;
export type GeminiHookEvent = (typeof GEMINI_HOOK_EVENTS)[number];

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
        case 'write_todos':
            return 'Updating its to-do list';
        // The built-in tools of Gemini CLI.
        case 'run_shell_command': {
            const description = text(input.description);
            return description ? oneLine(description, 70) : `Running ${oneLine(text(input.command) ?? 'a command', 60)}`;
        }
        case 'replace':
        case 'write_file':
            return `Editing ${fileName(input.file_path) ?? 'a file'}`;
        case 'read_file':
            return `Reading ${fileName(input.file_path ?? input.absolute_path) ?? 'a file'}`;
        case 'read_many_files':
            return 'Reading files';
        case 'list_directory':
            return `Listing ${fileName(input.dir_path ?? input.path) ?? 'a folder'}`;
        case 'search_file_content':
        case 'grep_search':
            return text(input.pattern) ? `Searching for "${oneLine(text(input.pattern)!, 40)}"` : 'Searching the code';
        case 'glob':
            return text(input.pattern) ? `Finding files ${oneLine(text(input.pattern)!, 40)}` : 'Finding files';
        case 'web_fetch':
            return 'Reading a web page';
        case 'google_web_search':
            return text(input.query) ? `Searching the web for "${oneLine(text(input.query)!, 40)}"` : 'Searching the web';
        case 'save_memory':
            return 'Saving a memory';
        // The built-in tools of opencode. The file path is "filePath".
        case 'bash': {
            const description = text(input.description);
            return description ? oneLine(description, 70) : `Running ${oneLine(text(input.command) ?? 'a command', 60)}`;
        }
        case 'edit':
        case 'write':
        case 'multiedit':
            return `Editing ${fileName(input.filePath) ?? 'a file'}`;
        case 'patch':
        case 'apply_patch':
            return 'Editing files';
        case 'read':
            return `Reading ${fileName(input.filePath) ?? 'a file'}`;
        case 'list':
            return `Listing ${fileName(input.path) ?? 'a folder'}`;
        case 'grep':
            return text(input.pattern) ? `Searching for "${oneLine(text(input.pattern)!, 40)}"` : 'Searching the code';
        case 'webfetch': {
            try {
                return `Reading ${new URL(String(input.url)).host}`;
            } catch {
                return 'Reading a web page';
            }
        }
        case 'websearch':
        case 'codesearch':
            return text(input.query) ? `Searching the web for "${oneLine(text(input.query)!, 40)}"` : 'Searching the web';
        case 'task':
            return text(input.description) ? `Running a subagent: ${oneLine(text(input.description)!, 50)}` : 'Running a subagent';
        case 'todowrite':
            return 'Updating its to-do list';
        case 'question':
            return 'Asking a question';
        default: {
            // Claude Code MCP tools are "mcp__<server>__<tool>".
            const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
            return mcp ? `Using ${mcp[2].replace(/_/g, ' ')} (${mcp[1]})` : `Using ${tool}`;
        }
    }
}

function toolChange(payload: Record<string, unknown>): AgentStateChange {
    return {
        state: 'working',
        message: describeTool(
            String(payload.tool_name ?? 'a tool'),
            (payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}) as Record<string, unknown>
        )
    };
}

/**
 * Converts a Claude Code or Gemini CLI hook event to an agent state.
 * `current` is the state before the event. Returns undefined for an event that does not change the state.
 */
export function agentStateFromHook(event: string, payload: Record<string, unknown>, current?: AgentState): AgentStateChange | undefined {
    switch (event) {
        case 'SessionStart':
            return { state: 'idle' };
        case 'UserPromptSubmit':
        case 'BeforeAgent': {
            const prompt = text(payload.prompt);
            return { state: 'working', message: 'Reading your prompt', ...(prompt ? { prompt: oneLine(prompt, 120) } : {}) };
        }
        case 'PreToolUse':
        case 'BeforeTool':
            // A tool call after a permission prompt means that the user answered, so the agent works again.
            return toolChange(payload);
        case 'AfterTool':
            // Gemini CLI can send BeforeTool before its permission prompt. AfterTool then shows that the user answered.
            return toolChange(payload);
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
        case 'AfterAgent':
            return { state: 'done', message: text(payload.prompt_response) };
        case 'SessionEnd':
            // The agents send SessionEnd with the reason "clear" for /clear. A SessionStart follows, so the agent did not exit.
            if (payload.reason === 'clear') {
                return undefined;
            }
            return { state: 'exited' };
        default:
            return undefined;
    }
}

/**
 * Returns the shell command of one hook. The command sends the event JSON (on stdin) to ShipWarden's hook server.
 * The environment of the terminal supplies the URL, the token and the session ID, so one settings file serves all sessions.
 * A failed request must not block the agent, so the command always succeeds. It writes nothing to stdout.
 * A PTY host from the time when the app was Yardmaster sets YARDMASTER_* variables and reads the X-Yardmaster-Token
 * header. The command uses those when the new variables are not set, so agents of an old host also report their state.
 * Gemini CLI can remove a variable with "TOKEN" in its name from the environment of a hook. It always keeps a
 * variable with a name that starts with GEMINI_CLI_. Thus the Gemini command reads the GEMINI_CLI_SHIPWARDEN_* copies first.
 */
function hookCommand(event: string, gemini: boolean): string {
    const value = (name: string): string =>
        gemini ? `\${GEMINI_CLI_SHIPWARDEN_${name}:-\${SHIPWARDEN_${name}:-$YARDMASTER_${name}}}` : `\${SHIPWARDEN_${name}:-$YARDMASTER_${name}}`;
    const token = value('HOOK_TOKEN');
    return (
        `curl -s -m 2 -o /dev/null -X POST -H "X-ShipWarden-Token: ${token}" -H "X-Yardmaster-Token: ${token}" ` +
        `--data-binary @- "${value('HOOK_URL')}/hook/${value('SESSION_ID')}/${event}" || true`
    );
}

/** Returns the hook settings that ShipWarden gives to Claude Code with --settings. */
export function claudeHookSettings(): { hooks: Record<string, unknown[]> } {
    const hooks: Record<string, unknown[]> = {};
    for (const event of HOOK_EVENTS) {
        hooks[event] = [{ ...(event === 'PreToolUse' ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: hookCommand(event, false), timeout: 5 }] }];
    }
    return { hooks };
}

/** The name of ShipWarden's hooks in Gemini CLI. The user sees this name in /hooks and can disable the hooks with it. */
export const GEMINI_HOOK_NAME = 'shipwarden-agent-state';

/**
 * Returns the settings file that ShipWarden gives to Gemini CLI as its "system defaults" file
 * (the GEMINI_CLI_SYSTEM_DEFAULTS_PATH variable). Gemini CLI has no --settings option.
 * The system defaults file has the lowest priority, and Gemini CLI adds the hooks of all settings files together.
 * Thus the user's own settings and hooks stay the same.
 * `base` is the system defaults file that was there before (for example from an administrator). The result keeps all
 * of its values and adds ShipWarden's hooks after its hooks.
 */
export function geminiHookSettings(base: unknown = {}): Record<string, unknown> {
    const settings: Record<string, unknown> = base && typeof base === 'object' && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {};
    const baseHooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? (settings.hooks as Record<string, unknown>) : {};
    const hooks: Record<string, unknown> = { ...baseHooks };
    for (const event of GEMINI_HOOK_EVENTS) {
        const own = Array.isArray(baseHooks[event]) ? (baseHooks[event] as unknown[]) : [];
        const isTool = event === 'BeforeTool' || event === 'AfterTool';
        // Gemini CLI uses milliseconds for the timeout.
        const hook = { name: GEMINI_HOOK_NAME, type: 'command', command: hookCommand(event, true), timeout: 5000 };
        hooks[event] = [...own, { ...(isTool ? { matcher: '.*' } : {}), hooks: [hook] }];
    }
    settings.hooks = hooks;
    return settings;
}

/** Quotes a value for a POSIX shell. */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Returns the inline opencode config (the OPENCODE_CONFIG_CONTENT variable) that loads ShipWarden's plugin.
 * opencode adds the plugins of all config files together, so the user's own plugins and settings stay the same.
 * `pluginPath` is the absolute path of the plugin file.
 */
export function opencodeHookConfig(pluginPath: string): string {
    return JSON.stringify({ plugin: [`file://${encodeURI(pluginPath)}`] });
}

/** The agents that report their state through hooks. */
export type HookAgent = 'claude' | 'gemini' | 'opencode';

/** Returns the agent of a command if ShipWarden can give it hooks. Returns undefined for other agents. */
export function hookAgentOf(command: string): HookAgent | undefined {
    const program = command.trim().split(/\s+/)[0];
    const name = program.slice(program.lastIndexOf('/') + 1);
    return name === 'claude' || name === 'gemini' || name === 'opencode' ? name : undefined;
}

/** The hook settings files of the agents. */
export interface HookSettingsPaths {
    /** The file that Claude Code gets with --settings. */
    claude: string;
    /** The file that Gemini CLI gets in GEMINI_CLI_SYSTEM_DEFAULTS_PATH. */
    gemini: string;
    /** The opencode plugin file. opencode gets it in OPENCODE_CONFIG_CONTENT. */
    opencode: string;
}

/**
 * Adds ShipWarden's hook settings to an agent command when the agent is Claude Code, Gemini CLI or opencode.
 * Other agents keep their command, and ShipWarden shows no detailed state for them.
 */
export function withAgentHooks(command: string, paths: HookSettingsPaths): string {
    switch (hookAgentOf(command)) {
        case 'claude':
            return `${command.trim()} --settings ${shellQuote(paths.claude)}`;
        case 'gemini':
            return `GEMINI_CLI_SYSTEM_DEFAULTS_PATH=${shellQuote(paths.gemini)} ${command.trim()}`;
        case 'opencode':
            return `OPENCODE_CONFIG_CONTENT=${shellQuote(opencodeHookConfig(paths.opencode))} ${command.trim()}`;
        default:
            return command;
    }
}
