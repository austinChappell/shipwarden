import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentStateFromHook } from '@shared/agents';
import { OPENCODE_PLUGIN, writeOpencodePlugin } from './opencode-plugin';

type Hooks = {
    'chat.message'?: (input: unknown, output: unknown) => Promise<void>;
    'tool.execute.before'?: (input: unknown, output: unknown) => Promise<void>;
    event?: (input: { event: { type: string; properties: Record<string, unknown> } }) => Promise<void>;
};

describe('opencode plugin', () => {
    let folder: string;
    let sent: { url: string; event: string; payload: Record<string, unknown>; token: string }[];

    beforeEach(() => {
        folder = mkdtempSync(join(tmpdir(), 'shipwarden opencode-'));
        sent = [];
        vi.stubGlobal('fetch', async (url: string, init: { body: string; headers: Record<string, string> }) => {
            sent.push({ url, event: url.split('/').pop()!, payload: JSON.parse(init.body), token: init.headers['X-ShipWarden-Token'] });
            return new Response(null, { status: 204 });
        });
        vi.stubEnv('SHIPWARDEN_HOOK_URL', 'http://127.0.0.1:4000');
        vi.stubEnv('SHIPWARDEN_HOOK_TOKEN', 'secret');
        vi.stubEnv('SHIPWARDEN_SESSION_ID', 'term-1');
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        rmSync(folder, { recursive: true, force: true });
    });

    async function load(): Promise<Hooks> {
        const target = join(folder, 'plugin', 'shipwarden-agent-state.js');
        writeOpencodePlugin(target);
        expect(readFileSync(target, 'utf8')).toBe(OPENCODE_PLUGIN);
        const module = await import(/* @vite-ignore */ `${pathToFileURL(target).href}?t=${Date.now()}`);
        return module.ShipWardenAgentState({});
    }

    const event = (hooks: Hooks, type: string, properties: Record<string, unknown>) => hooks.event!({ event: { type, properties } });
    const events = () => sent.map(item => item.event);

    it('sends a turn as Claude Code events that map to agent states', async () => {
        const hooks = await load();
        await hooks['chat.message']!(
            { sessionID: 's1' },
            {
                parts: [
                    { type: 'text', text: 'Fix the test' },
                    { type: 'text', text: 'hidden', synthetic: true }
                ]
            }
        );
        await hooks['tool.execute.before']!({ tool: 'read', sessionID: 's1' }, { args: { filePath: '/repo/notes.txt' } });
        await event(hooks, 'message.updated', { info: { id: 'm1', role: 'assistant', sessionID: 's1' } });
        await event(hooks, 'message.part.updated', { part: { type: 'text', messageID: 'm1', text: 'The test passes now.' } });
        await event(hooks, 'session.status', { sessionID: 's1', status: { type: 'idle' } });
        // opencode also sends the older session.idle event. The turn ends only one time.
        await event(hooks, 'session.idle', { sessionID: 's1' });

        expect(events()).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']);
        expect(sent[0].url).toBe('http://127.0.0.1:4000/hook/term-1/SessionStart');
        expect(sent.every(item => item.token === 'secret')).toBe(true);
        const states = sent.map(item => agentStateFromHook(item.event, item.payload));
        expect(states).toEqual([
            { state: 'idle' },
            { state: 'working', message: 'Reading your prompt', prompt: 'Fix the test' },
            { state: 'working', message: 'Reading notes.txt' },
            { state: 'done', message: 'The test passes now.' }
        ]);
    });

    it('waits for the user on a permission or a question, and works again after the answer', async () => {
        const hooks = await load();
        await hooks['chat.message']!({ sessionID: 's1' }, { parts: [{ type: 'text', text: 'Run it' }] });
        await hooks['tool.execute.before']!({ tool: 'bash', sessionID: 's1' }, { args: { command: 'npm test' } });
        await event(hooks, 'permission.asked', { sessionID: 's1', permission: 'bash', patterns: ['npm test'] });
        await event(hooks, 'permission.replied', { sessionID: 's1', reply: 'once' });
        await event(hooks, 'question.asked', { sessionID: 's1', questions: [{ question: 'Which branch?' }] });

        const [, , , permission, replied, question] = sent;
        expect(agentStateFromHook(permission.event, permission.payload)).toEqual({
            state: 'waiting',
            message: 'opencode asks for permission: bash (npm test)'
        });
        expect(agentStateFromHook(replied.event, replied.payload)).toEqual({ state: 'working', message: 'Running npm test' });
        expect(agentStateFromHook(question.event, question.payload)).toEqual({ state: 'waiting', message: 'Which branch?' });
    });

    it('does not end the turn when a subagent session becomes idle', async () => {
        const hooks = await load();
        await hooks['chat.message']!({ sessionID: 's1' }, { parts: [{ type: 'text', text: 'Use a subagent' }] });
        await event(hooks, 'session.created', { info: { id: 'child', parentID: 's1' } });
        await hooks['chat.message']!({ sessionID: 'child' }, { parts: [{ type: 'text', text: 'Subagent prompt' }] });
        await event(hooks, 'session.status', { sessionID: 'child', status: { type: 'idle' } });
        expect(events()).toEqual(['SessionStart', 'UserPromptSubmit']);
        await event(hooks, 'session.status', { sessionID: 's1', status: { type: 'idle' } });
        expect(events()).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
    });

    it('does nothing outside ShipWarden', async () => {
        vi.stubEnv('SHIPWARDEN_SESSION_ID', '');
        expect(await load()).toEqual({});
        expect(sent).toEqual([]);
    });
});
