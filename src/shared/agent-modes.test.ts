import { describe, expect, it } from 'vitest';
import { agentStartCommand, claudeModeOnScreen, commandWithMode, modesOf } from './agent-modes';
import { normalizeDefinition } from './automations';
import { normalizeSettings } from './settings';

describe('commandWithMode', () => {
    it('adds the options of the mode for each program', () => {
        expect(commandWithMode('claude --model opus', 'claude', 'auto', 'Claude Code')).toBe('claude --model opus --permission-mode auto');
        expect(commandWithMode('codex', 'codex', 'auto', 'Codex')).toBe('codex --sandbox workspace-write --ask-for-approval never');
        expect(commandWithMode('gemini', 'gemini', 'acceptEdits', 'Gemini CLI')).toBe('gemini --approval-mode auto_edit');
        expect(commandWithMode('opencode', 'opencode', 'auto', 'opencode')).toBe('opencode --auto');
    });

    it('refuses a mode that the program does not have, and a program that it does not know', () => {
        expect(() => commandWithMode('opencode', 'opencode', 'plan', 'opencode')).toThrow('does not have the mode "Plan"');
        expect(() => commandWithMode('aider', undefined, 'auto', 'Aider')).toThrow('cannot set the mode "Auto" for the agent "Aider"');
    });
});

describe('agentStartCommand', () => {
    const claude = { name: 'Claude Code', command: 'claude' };

    it('uses the default mode of the agent, and a given mode replaces it', () => {
        expect(agentStartCommand(claude)).toBe('claude');
        expect(agentStartCommand({ ...claude, mode: 'acceptEdits' })).toBe('claude --permission-mode acceptEdits');
        expect(agentStartCommand({ ...claude, mode: 'acceptEdits' }, 'auto')).toBe('claude --permission-mode auto');
    });
});

describe('modesOf', () => {
    it('lists the modes of a program', () => {
        expect(modesOf('claude')).toEqual(['auto', 'acceptEdits', 'plan', 'bypassPermissions']);
        expect(modesOf('opencode')).toEqual(['auto', 'bypassPermissions']);
        expect(modesOf(undefined)).toEqual([]);
    });
});

describe('claudeModeOnScreen', () => {
    it('reads the mode from the status line, also without spaces', () => {
        expect(claudeModeOnScreen('> \n  ⏵⏵ auto mode on (shift+tab to cycle)')).toBe('auto');
        expect(claudeModeOnScreen('⏵⏵acceptediTson(shift+tabtocycle)')).toBe('acceptEdits');
        expect(claudeModeOnScreen('⏸ plan mode on')).toBe('plan');
        expect(claudeModeOnScreen('? for shortcuts')).toBe('default');
    });
});

describe('the mode in settings and automations', () => {
    it('keeps a valid default mode of an agent and drops a wrong one', () => {
        const settings = normalizeSettings({
            agents: [
                { id: 'a', name: 'A', command: 'claude', mode: 'auto' },
                { id: 'b', name: 'B', command: 'codex', mode: 'fast' }
            ]
        });
        expect(settings.agents).toEqual([
            { id: 'a', name: 'A', command: 'claude', mode: 'auto' },
            { id: 'b', name: 'B', command: 'codex' }
        ]);
    });

    it('reads the mode of the agent actions and refuses a wrong mode', () => {
        const definition = (mode: unknown) => ({
            name: 'Fix CI',
            trigger: { type: 'ci.failed' },
            actions: [{ type: 'sendToAgent', prompt: 'Fix it', mode }],
            limits: {}
        });
        expect(normalizeDefinition(definition('auto')).actions).toEqual([{ type: 'sendToAgent', prompt: 'Fix it', mode: 'auto' }]);
        expect(normalizeDefinition(definition(undefined)).actions).toEqual([{ type: 'sendToAgent', prompt: 'Fix it' }]);
        expect(() => normalizeDefinition(definition('fast'))).toThrow('has the mode "fast"');
    });
});
