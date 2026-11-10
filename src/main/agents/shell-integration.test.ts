import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shellIntegrationEnv, writeBashIntegration, ZSHENV } from './shell-integration';

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

describe('bash shell integration', () => {
    it('gives bash the path of the startup file, and no ZDOTDIR', () => {
        const env = shellIntegrationEnv({ SHELL: '/bin/bash' }, { ...integration, bashInitFile: '/data/shell-integration/init.bash' });
        expect(env).toEqual({ SHIPWARDEN_HOOK_SETTINGS: '/data/claude-hooks.json', SHIPWARDEN_BASH_INIT: '/data/shell-integration/init.bash' });
        expect(
            shellIntegrationEnv({ SHELL: '/bin/zsh' }, { ...integration, bashInitFile: '/data/shell-integration/init.bash' }).SHIPWARDEN_BASH_INIT
        ).toBeUndefined();
    });

    describe.runIf(existsSync('/bin/bash'))('the startup file', () => {
        let folder: string;
        let home: string;
        let bin: string;
        let init: string;
        let settings: string;

        beforeEach(() => {
            folder = mkdtempSync(join(tmpdir(), 'sw-bash-'));
            home = join(folder, 'home');
            bin = join(folder, 'bin');
            settings = join(folder, 'claude-hooks.json');
            mkdirSync(home);
            mkdirSync(bin);
            writeFileSync(settings, '{}');
            // A claude program that prints its arguments.
            writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "args: $*"\n');
            chmodSync(join(bin, 'claude'), 0o755);
            init = writeBashIntegration(join(folder, 'shell-integration', 'init.bash'));
        });

        afterEach(() => rmSync(folder, { recursive: true, force: true }));

        function run(script: string): string {
            // A pipe is not a terminal, so bash needs -i to read the startup file.
            return execFileSync('/bin/bash', ['--init-file', init, '-i', '-c', script], {
                env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, SHIPWARDEN_HOOK_SETTINGS: settings },
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
        }

        it('reads the login file of the user and adds the hook settings to claude', () => {
            writeFileSync(join(home, '.bash_profile'), 'export FROM_PROFILE=yes\n');
            const output = run('echo "profile=$FROM_PROFILE"; claude fix the bug; claude --settings mine.json');
            expect(output).toContain('profile=yes');
            expect(output).toContain(`args: --settings ${settings} fix the bug`);
            expect(output).toContain('args: --settings mine.json\n');
        });

        it('keeps a claude function and a claude alias of the user', () => {
            writeFileSync(join(home, '.bash_profile'), 'function claude { echo mine; }\n');
            expect(run('claude hi')).toContain('mine');
            writeFileSync(join(home, '.bash_profile'), "shopt -s expand_aliases\nalias claude='echo alias'\n");
            expect(run('claude hi')).toContain('alias hi');
        });
    });
});
