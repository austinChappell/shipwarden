import { describe, expect, it } from 'vitest';
import { shellIntegrationEnv } from './shell-integration';

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
        expect(shellIntegrationEnv({ SHELL: '/bin/zsh', ZDOTDIR: '/home/me/.config/zsh' }, integration).SHIPWARDEN_USER_ZDOTDIR)
            .toBe('/home/me/.config/zsh');
        // The app started from a ShipWarden terminal: ZDOTDIR is the folder of ShipWarden.
        expect(shellIntegrationEnv({ SHELL: '/bin/zsh', ZDOTDIR: integration.zshFolder }, integration).SHIPWARDEN_USER_ZDOTDIR)
            .toBeUndefined();
    });

    it('does not change ZDOTDIR for other shells or without the folder', () => {
        expect(shellIntegrationEnv({ SHELL: '/bin/bash' }, integration)).toEqual({ SHIPWARDEN_HOOK_SETTINGS: '/data/claude-hooks.json' });
        expect(shellIntegrationEnv({ SHELL: '/bin/zsh' }, { hookSettingsPath: '/data/claude-hooks.json' }))
            .toEqual({ SHIPWARDEN_HOOK_SETTINGS: '/data/claude-hooks.json' });
    });
});
