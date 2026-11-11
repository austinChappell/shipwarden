import { describe, expect, it } from 'vitest';
import {
    agentStateFromHook,
    describeTool,
    oneLine,
    claudeHookSettings,
    GEMINI_HOOK_EVENTS,
    GEMINI_HOOK_NAME,
    geminiHookSettings,
    HOOK_EVENTS,
    hookAgentOf,
    opencodeHookConfig,
    shellQuote,
    withAgentHooks,
    worktreeAgentState
} from './agents';

describe('agentStateFromHook', () => {
    it('maps the hook events to agent states', () => {
        expect(agentStateFromHook('SessionStart', { source: 'startup' })).toEqual({ state: 'idle' });
        expect(agentStateFromHook('UserPromptSubmit', { prompt: '  Fix the\nlogin page ' })).toEqual({
            state: 'working',
            message: 'Reading your prompt',
            prompt: 'Fix the login page'
        });
        expect(agentStateFromHook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } })).toEqual({
            state: 'working',
            message: 'Running npm test'
        });
        expect(agentStateFromHook('Notification', { message: 'Claude needs your permission to use Bash' })).toEqual({
            state: 'waiting',
            message: 'Claude needs your permission to use Bash'
        });
        expect(agentStateFromHook('Notification', {})).toEqual({ state: 'waiting', message: 'The agent needs your input.' });
        expect(agentStateFromHook('Stop', { last_assistant_message: ' I fixed the bug. ' })).toEqual({ state: 'done', message: 'I fixed the bug.' });
        expect(agentStateFromHook('Stop', { transcript_path: '/u/.claude/projects/p/s.jsonl' })).toEqual({
            state: 'done',
            transcript: '/u/.claude/projects/p/s.jsonl'
        });
        expect(agentStateFromHook('Stop', { transcript_path: '/tmp/x.txt' })).toEqual({ state: 'done' });
        expect(agentStateFromHook('SessionEnd', { reason: 'other' })).toEqual({ state: 'exited' });
        expect(agentStateFromHook('PostToolUse', {})).toBeUndefined();
    });

    it('maps the Gemini CLI hook events to agent states', () => {
        expect(agentStateFromHook('SessionStart', { source: 'startup', hook_event_name: 'SessionStart' })).toEqual({ state: 'idle' });
        expect(agentStateFromHook('BeforeAgent', { prompt: ' Add a\ntest ' })).toEqual({
            state: 'working',
            message: 'Reading your prompt',
            prompt: 'Add a test'
        });
        expect(agentStateFromHook('BeforeTool', { tool_name: 'run_shell_command', tool_input: { command: 'npm test' } })).toEqual({
            state: 'working',
            message: 'Running npm test'
        });
        expect(agentStateFromHook('Notification', { notification_type: 'ToolPermission', message: 'Allow run_shell_command?' }, 'working')).toEqual({
            state: 'waiting',
            message: 'Allow run_shell_command?'
        });
        // The user answered the permission prompt, and the tool ran.
        expect(agentStateFromHook('AfterTool', { tool_name: 'replace', tool_input: { file_path: '/repo/src/App.tsx' } }, 'waiting')).toEqual({
            state: 'working',
            message: 'Editing App.tsx'
        });
        expect(agentStateFromHook('AfterAgent', { prompt: 'Add a test', prompt_response: ' I added the test. ' })).toEqual({
            state: 'done',
            message: 'I added the test.'
        });
        expect(agentStateFromHook('AfterAgent', {})).toEqual({ state: 'done', message: undefined });
        expect(agentStateFromHook('SessionEnd', { reason: 'exit' })).toEqual({ state: 'exited' });
        expect(agentStateFromHook('BeforeModel', {})).toBeUndefined();
    });

    it('does not show "exited" when the user clears the session', () => {
        expect(agentStateFromHook('SessionEnd', { reason: 'clear' }, 'done')).toBeUndefined();
    });

    it('keeps "done" for the idle notification, but shows a permission prompt', () => {
        const idle = { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' };
        expect(agentStateFromHook('Notification', idle, 'done')).toBeUndefined();
        expect(agentStateFromHook('Notification', idle, 'idle')).toBeUndefined();
        expect(agentStateFromHook('Notification', idle, 'working')).toEqual({ state: 'waiting', message: 'Claude is waiting for your input' });
        expect(
            agentStateFromHook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, 'working')
        ).toEqual({ state: 'waiting', message: 'Claude needs your permission to use Bash' });
        expect(agentStateFromHook('Notification', { notification_type: 'auth_success' }, 'working')).toBeUndefined();
    });
});

describe('worktreeAgentState', () => {
    it('shows the state that needs the user most', () => {
        expect(worktreeAgentState(['done', 'waiting', 'working'])).toBe('waiting');
        expect(worktreeAgentState(['idle', undefined, 'working'])).toBe('working');
        expect(worktreeAgentState([undefined])).toBeUndefined();
    });
});

describe('claudeHookSettings', () => {
    it('has one curl hook for each event, and PreToolUse matches all tools', () => {
        const settings = claudeHookSettings();
        expect(Object.keys(settings.hooks)).toEqual([...HOOK_EVENTS]);
        const preToolUse = settings.hooks.PreToolUse[0] as { matcher: string; hooks: { command: string }[] };
        expect(preToolUse.matcher).toBe('*');
        expect(preToolUse.hooks[0].command).toContain(
            '"${SHIPWARDEN_HOOK_URL:-$YARDMASTER_HOOK_URL}/hook/${SHIPWARDEN_SESSION_ID:-$YARDMASTER_SESSION_ID}/PreToolUse"'
        );
        expect(preToolUse.hooks[0].command.endsWith('|| true')).toBe(true);
    });
});

describe('geminiHookSettings', () => {
    type Group = { matcher?: string; hooks: { name: string; type: string; command: string; timeout: number }[] };

    it('has one named curl hook for each event, and the tool events match all tools', () => {
        const settings = geminiHookSettings();
        const hooks = settings.hooks as Record<string, Group[]>;
        expect(Object.keys(hooks)).toEqual([...GEMINI_HOOK_EVENTS]);
        const beforeTool = hooks.BeforeTool[0];
        expect(beforeTool.matcher).toBe('.*');
        expect(hooks.AfterAgent[0].matcher).toBeUndefined();
        expect(beforeTool.hooks[0]).toMatchObject({ name: GEMINI_HOOK_NAME, type: 'command', timeout: 5000 });
        expect(beforeTool.hooks[0].command).toContain(
            '"${GEMINI_CLI_SHIPWARDEN_HOOK_URL:-${SHIPWARDEN_HOOK_URL:-$YARDMASTER_HOOK_URL}}/hook/${GEMINI_CLI_SHIPWARDEN_SESSION_ID:-${SHIPWARDEN_SESSION_ID:-$YARDMASTER_SESSION_ID}}/BeforeTool"'
        );
        expect(beforeTool.hooks[0].command).toContain(
            'X-ShipWarden-Token: ${GEMINI_CLI_SHIPWARDEN_HOOK_TOKEN:-${SHIPWARDEN_HOOK_TOKEN:-$YARDMASTER_HOOK_TOKEN}}'
        );
        expect(beforeTool.hooks[0].command.endsWith('|| true')).toBe(true);
    });

    it('keeps the values and hooks of the system defaults file', () => {
        const adminHook = { matcher: 'write_file', hooks: [{ type: 'command', command: 'audit.sh' }] };
        const settings = geminiHookSettings({ ui: { theme: 'GitHub' }, hooks: { BeforeTool: [adminHook], PreCompress: [adminHook] } });
        expect(settings.ui).toEqual({ theme: 'GitHub' });
        const hooks = settings.hooks as Record<string, Group[]>;
        expect(hooks.BeforeTool).toHaveLength(2);
        expect(hooks.BeforeTool[0]).toBe(adminHook);
        expect(hooks.BeforeTool[1].hooks[0].name).toBe(GEMINI_HOOK_NAME);
        expect(hooks.PreCompress).toEqual([adminHook]);
    });

    it('ignores a system defaults file that is not an object', () => {
        expect(Object.keys(geminiHookSettings([1, 2]))).toEqual(['hooks']);
        expect(Object.keys(geminiHookSettings(null))).toEqual(['hooks']);
        expect(Object.keys(geminiHookSettings({ hooks: 'bad' }).hooks as object)).toEqual([...GEMINI_HOOK_EVENTS]);
    });
});

describe('withAgentHooks', () => {
    const paths = {
        claude: '/Users/me/Library/Application Support/shipwarden/claude-hooks.json',
        gemini: '/Users/me/Library/Application Support/shipwarden/gemini-hooks.json',
        opencode: '/Users/me/Library/Application Support/shipwarden/opencode/shipwarden-agent-state.js'
    };

    it('adds the settings to Claude Code and quotes the path', () => {
        expect(withAgentHooks('claude', paths)).toBe(`claude --settings '${paths.claude}'`);
        expect(withAgentHooks('/opt/bin/claude --model opus', paths)).toBe(`/opt/bin/claude --model opus --settings '${paths.claude}'`);
    });

    it('gives Gemini CLI the settings as its system defaults file', () => {
        expect(withAgentHooks('gemini', paths)).toBe(`GEMINI_CLI_SYSTEM_DEFAULTS_PATH='${paths.gemini}' gemini`);
        expect(withAgentHooks(' /opt/homebrew/bin/gemini --yolo ', paths)).toBe(
            `GEMINI_CLI_SYSTEM_DEFAULTS_PATH='${paths.gemini}' /opt/homebrew/bin/gemini --yolo`
        );
    });

    it('gives opencode an inline config that loads the plugin', () => {
        const config = '{"plugin":["file:///Users/me/Library/Application%20Support/shipwarden/opencode/shipwarden-agent-state.js"]}';
        expect(opencodeHookConfig(paths.opencode)).toBe(config);
        expect(withAgentHooks('opencode --model anthropic/claude-sonnet-4', paths)).toBe(
            `OPENCODE_CONFIG_CONTENT='${config}' opencode --model anthropic/claude-sonnet-4`
        );
        expect(hookAgentOf('/Users/me/.opencode/bin/opencode')).toBe('opencode');
    });

    it('keeps the command of other agents', () => {
        expect(withAgentHooks('codex', paths)).toBe('codex');
        expect(withAgentHooks('gemini-helper', paths)).toBe('gemini-helper');
        expect(hookAgentOf('aider --yes')).toBeUndefined();
        expect(hookAgentOf('/usr/local/bin/gemini')).toBe('gemini');
    });

    it('quotes single quotes for the shell', () => {
        expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    });
});

describe('describeTool', () => {
    it('describes the common tools for people', () => {
        expect(describeTool('Bash', { command: 'npm test', description: 'Run the unit tests' })).toBe('Run the unit tests');
        expect(describeTool('Edit', { file_path: '/repo/src/App.tsx' })).toBe('Editing App.tsx');
        expect(describeTool('Read', { file_path: '/repo/README.md' })).toBe('Reading README.md');
        expect(describeTool('Grep', { pattern: 'useAppearance' })).toBe('Searching for "useAppearance"');
        expect(describeTool('WebFetch', { url: 'https://docs.github.com/en/rest' })).toBe('Reading docs.github.com');
        expect(describeTool('WebFetch', { url: 'not a url' })).toBe('Reading a web page');
        expect(describeTool('Task', { description: 'Find the flaky test' })).toBe('Running a subagent: Find the flaky test');
        expect(describeTool('mcp__clickup__get_task', {})).toBe('Using get task (clickup)');
        expect(describeTool('Unknown')).toBe('Using Unknown');
    });

    it('describes the Gemini CLI tools for people', () => {
        expect(describeTool('run_shell_command', { command: 'npm test', description: 'Run the unit tests' })).toBe('Run the unit tests');
        expect(describeTool('replace', { file_path: '/repo/src/App.tsx' })).toBe('Editing App.tsx');
        expect(describeTool('write_file', { file_path: '/repo/NOTES.md' })).toBe('Editing NOTES.md');
        expect(describeTool('read_file', { absolute_path: '/repo/README.md' })).toBe('Reading README.md');
        expect(describeTool('search_file_content', { pattern: 'useAppearance' })).toBe('Searching for "useAppearance"');
        expect(describeTool('google_web_search', { query: 'vitest mocks' })).toBe('Searching the web for "vitest mocks"');
        expect(describeTool('write_todos', {})).toBe('Updating its to-do list');
    });

    it('describes the opencode tools for people', () => {
        expect(describeTool('bash', { command: 'npm test', description: 'Run the unit tests' })).toBe('Run the unit tests');
        expect(describeTool('bash', { command: 'echo done' })).toBe('Running echo done');
        expect(describeTool('edit', { filePath: '/repo/src/App.tsx' })).toBe('Editing App.tsx');
        expect(describeTool('read', { filePath: '/repo/notes.txt' })).toBe('Reading notes.txt');
        expect(describeTool('list', { path: '/repo/src' })).toBe('Listing src');
        expect(describeTool('grep', { pattern: 'useAppearance' })).toBe('Searching for "useAppearance"');
        expect(describeTool('webfetch', { url: 'https://opencode.ai/docs' })).toBe('Reading opencode.ai');
        expect(describeTool('task', { description: 'Read notes.txt' })).toBe('Running a subagent: Read notes.txt');
        expect(describeTool('todowrite', {})).toBe('Updating its to-do list');
    });

    it('keeps long text on one short line', () => {
        expect(oneLine('a\n  b', 80)).toBe('a b');
        expect(oneLine('x'.repeat(100), 10)).toBe('xxxxxxxxx…');
    });
});
