import { describe, expect, it } from 'vitest';
import { agentStateFromHook, describeTool, oneLine, claudeHookSettings, HOOK_EVENTS, shellQuote, withAgentHooks, worktreeAgentState } from './agents';

describe('agentStateFromHook', () => {
    it('maps the hook events to agent states', () => {
        expect(agentStateFromHook('SessionStart', { source: 'startup' })).toEqual({ state: 'idle' });
        expect(agentStateFromHook('UserPromptSubmit', { prompt: '  Fix the\nlogin page ' })).toEqual({ state: 'working', message: 'Reading your prompt', prompt: 'Fix the login page' });
        expect(agentStateFromHook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } })).toEqual({ state: 'working', message: 'Running npm test' });
        expect(agentStateFromHook('Notification', { message: 'Claude needs your permission to use Bash' }))
            .toEqual({ state: 'waiting', message: 'Claude needs your permission to use Bash' });
        expect(agentStateFromHook('Notification', {})).toEqual({ state: 'waiting', message: 'The agent needs your input.' });
        expect(agentStateFromHook('Stop', { last_assistant_message: ' I fixed the bug. ' })).toEqual({ state: 'done', message: 'I fixed the bug.' });
        expect(agentStateFromHook('SessionEnd', { reason: 'other' })).toEqual({ state: 'exited' });
        expect(agentStateFromHook('PostToolUse', {})).toBeUndefined();
    });

    it('keeps "done" for the idle notification, but shows a permission prompt', () => {
        const idle = { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' };
        expect(agentStateFromHook('Notification', idle, 'done')).toBeUndefined();
        expect(agentStateFromHook('Notification', idle, 'idle')).toBeUndefined();
        expect(agentStateFromHook('Notification', idle, 'working')).toEqual({ state: 'waiting', message: 'Claude is waiting for your input' });
        expect(agentStateFromHook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, 'working'))
            .toEqual({ state: 'waiting', message: 'Claude needs your permission to use Bash' });
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
        expect(preToolUse.hooks[0].command).toContain('"${SHIPWARDEN_HOOK_URL:-$YARDMASTER_HOOK_URL}/hook/${SHIPWARDEN_SESSION_ID:-$YARDMASTER_SESSION_ID}/PreToolUse"');
        expect(preToolUse.hooks[0].command.endsWith('|| true')).toBe(true);
    });
});

describe('withAgentHooks', () => {
    const path = '/Users/me/Library/Application Support/shipwarden/claude-hooks.json';

    it('adds the settings to Claude Code and quotes the path', () => {
        expect(withAgentHooks('claude', path)).toBe(`claude --settings '${path}'`);
        expect(withAgentHooks('/opt/bin/claude --model opus', path)).toBe(`/opt/bin/claude --model opus --settings '${path}'`);
    });

    it('keeps the command of other agents', () => {
        expect(withAgentHooks('codex', path)).toBe('codex');
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

    it('keeps long text on one short line', () => {
        expect(oneLine('a\n  b', 80)).toBe('a b');
        expect(oneLine('x'.repeat(100), 10)).toBe('xxxxxxxxx…');
    });
});
