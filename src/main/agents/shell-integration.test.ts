import { describe, expect, it } from 'vitest';
import { shellIntegrationEnv, ZSHENV } from './shell-integration';

const integration = { hookSettingsPath: '/data/claude-hooks.json', zshFolder: '/data/shell-integration/zsh' };

describe('shellIntegrationEnv', () => {
    it('gives zsh the ZDOTDIR of ShipWarden', () => {
        expect(shellIntegrationEnv({ SHELL: '/bin/zsh' }, integration)).toEqual({
            SHIPWARDEN_HOOK_SETTINGS: '/data/claude-hooks.json',
            SHIPWARDEN_ZDOTDIR: '/data/shell-integration/zsh',
            ZDOTDIR: '/data/shell-integration/zsh'
        });
    });

    it('keeps the ZDOTDIR of the user', () => {
        expect(shellIntegrationEnv({ SHELL: '/bin/zsh', ZDOTDIR: '/home/me/.config/zsh' }, integration).SHIPWARDEN_USER_ZDOTDIR).toBe('/home/me/.config/zsh');
        // The app started from a ShipWarden terminal: ZDOTDIR is the folder of ShipWarden.
        expect(shellIntegrationEnv({ SHELL: '/bin/zsh', ZDOTDIR: integration.zshFolder }, integration).SHIPWARDEN_USER_ZDOTDIR).toBeUndefined();
    });

    it('does not change ZDOTDIR for other shells or without the folder', () => {
        expect(shellIntegrationEnv({ SHELL: '/bin/bash' }, integration)).toEqual({ SHIPWARDEN_HOOK_SETTINGS: '/data/claude-hooks.json' });
        expect(shellIntegrationEnv({ SHELL: '/bin/zsh' }, { hookSettingsPath: '/data/claude-hooks.json' })).toEqual({
            SHIPWARDEN_HOOK_SETTINGS: '/data/claude-hooks.json'
        });
    });
});

describe('Gemini CLI shell integration', () => {
    it('gives each terminal the path of the Gemini CLI hook settings', () => {
        const env = shellIntegrationEnv({ SHELL: '/bin/bash' }, { ...integration, geminiHookSettingsPath: '/data/gemini-hooks.json' });
        expect(env).toEqual({ SHIPWARDEN_HOOK_SETTINGS: '/data/claude-hooks.json', SHIPWARDEN_GEMINI_HOOK_SETTINGS: '/data/gemini-hooks.json' });
    });

    it('adds a gemini function that keeps the system defaults path of the user', () => {
        expect(ZSHENV).toContain('if (( ! $+functions[gemini] )); then');
        expect(ZSHENV).toContain('-z "${GEMINI_CLI_SYSTEM_DEFAULTS_PATH-}"');
        expect(ZSHENV).toContain('GEMINI_CLI_SYSTEM_DEFAULTS_PATH="$SHIPWARDEN_GEMINI_HOOK_SETTINGS" command gemini "$@"');
    });
});

describe('opencode shell integration', () => {
    it('gives each terminal the inline opencode config', () => {
        const env = shellIntegrationEnv({ SHELL: '/bin/bash' }, { ...integration, opencodeConfigContent: '{"plugin":["file:///data/p.js"]}' });
        expect(env.SHIPWARDEN_OPENCODE_CONFIG_CONTENT).toBe('{"plugin":["file:///data/p.js"]}');
    });

    it('adds an opencode function that keeps the inline config of the user', () => {
        expect(ZSHENV).toContain('if (( ! $+functions[opencode] )); then');
        expect(ZSHENV).toContain('-z "${OPENCODE_CONFIG_CONTENT-}"');
        expect(ZSHENV).toContain('OPENCODE_CONFIG_CONTENT="$SHIPWARDEN_OPENCODE_CONFIG_CONTENT" command opencode "$@"');
    });
});
