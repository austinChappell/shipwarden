import { describe, expect, it } from 'vitest';
import { agentStartCommand } from './agent-modes';
import { commandSetsModel, modelListCommands, parseClaudeModels, parseCodexModels, resolveModel } from './agent-models';
import { normalizeSettings } from './settings';

describe('parseClaudeModels', () => {
    it('reads the models from the initialize answer, without the "default" entry', () => {
        const answer = JSON.stringify({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: 'models',
                response: {
                    models: [
                        { value: 'default', displayName: 'Default (recommended)' },
                        { value: 'opus', displayName: 'Opus 5.5', description: 'For complex work' },
                        { value: 'claude-haiku-4-5-20251001' }
                    ]
                }
            }
        });
        // The terminal title code comes before the first line.
        const output = `\u001b]0;claude\u0007{"type":"system","subtype":"hook_started"}\n${answer}\n`;
        expect(parseClaudeModels(output)).toEqual([
            { id: 'opus', label: 'Opus 5.5', description: 'For complex work' },
            { id: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5-20251001' }
        ]);
    });

    it('refuses an output without the answer', () => {
        expect(() => parseClaudeModels('{"type":"result"}')).toThrow('did not send its list of models');
    });
});

describe('parseCodexModels', () => {
    it('reads the listed models and drops the hidden ones', () => {
        const output = JSON.stringify({
            models: [
                { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', description: 'Fast', visibility: 'list' },
                { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide' }
            ]
        });
        expect(parseCodexModels(output)).toEqual([{ id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol', description: 'Fast' }]);
        expect(() => parseCodexModels('not json')).toThrow('Codex did not send');
    });
});

describe('modelListCommands', () => {
    it('lists the models only for Claude Code and Codex', () => {
        expect(modelListCommands('claude').map(item => item.command)).toEqual([
            'claude -p --input-format stream-json --output-format stream-json --verbose --no-session-persistence --safe-mode',
            'claude -p --input-format stream-json --output-format stream-json --verbose --no-session-persistence'
        ]);
        expect(modelListCommands('codex')).toEqual([{ command: 'codex debug models', input: '' }]);
        expect(modelListCommands('opencode')).toEqual([]);
        expect(modelListCommands('gemini')).toEqual([]);
    });
});

describe('resolveModel', () => {
    const available = [{ id: 'opus', label: 'Opus' }];

    it('keeps an available model and a model that ShipWarden cannot check', () => {
        expect(resolveModel(undefined, available)).toEqual({});
        expect(resolveModel('opus', available)).toEqual({ model: 'opus' });
        expect(resolveModel('opus', undefined)).toEqual({ model: 'opus' });
    });

    it('drops a model that is not available now', () => {
        expect(resolveModel('old-model', available)).toEqual({ unavailable: 'old-model' });
    });
});

describe('the model in the start command', () => {
    it('adds the model after the mode, only for Claude Code and Codex', () => {
        expect(agentStartCommand({ name: 'Claude Code', command: 'claude', model: 'opus' })).toBe("claude --model 'opus'");
        expect(agentStartCommand({ name: 'Claude Code', command: 'claude', mode: 'plan', model: 'opus' })).toBe("claude --permission-mode plan --model 'opus'");
        expect(agentStartCommand({ name: 'Codex', command: 'codex', model: 'gpt-6.2-sol' })).toBe("codex --model 'gpt-6.2-sol'");
        expect(agentStartCommand({ name: 'opencode', command: 'opencode', model: 'x' })).toBe('opencode');
    });

    it('does not add a second model option', () => {
        expect(commandSetsModel('claude --model opus')).toBe(true);
        expect(commandSetsModel('codex -m gpt-6')).toBe(true);
        expect(commandSetsModel('claude --mcp-config x')).toBe(false);
        expect(agentStartCommand({ name: 'Claude Code', command: 'claude --model sonnet', model: 'opus' })).toBe('claude --model sonnet');
    });

    it('keeps a valid model in the settings and drops a wrong one', () => {
        const settings = normalizeSettings({
            agents: [
                { id: 'a', name: 'A', command: 'claude', model: 'opus' },
                { id: 'b', name: 'B', command: 'codex', model: 'two words' }
            ]
        });
        expect(settings.agents).toEqual([
            { id: 'a', name: 'A', command: 'claude', model: 'opus' },
            { id: 'b', name: 'B', command: 'codex' }
        ]);
    });
});
