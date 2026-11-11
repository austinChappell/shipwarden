import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings, type CommandCheck } from '@shared/settings';
import { SETUP_CHECK_IDS } from '@shared/setup-checks';
import { SetupChecks, type SetupCheckDependencies } from './setup-checks';

/** Returns setup checks with a complete setup. A test changes the parts that it needs. */
function checks(change: Partial<SetupCheckDependencies> = {}, settings: AppSettings = DEFAULT_SETTINGS) {
    const commands: string[] = [];
    const deps: SetupCheckDependencies = {
        checkCommand: async (command: string): Promise<CommandCheck> => {
            commands.push(command);
            return { program: command.split(' ')[0], path: `/usr/bin/${command.split(' ')[0]}` };
        },
        settings: async () => settings,
        activeRepoCount: async () => 2,
        githubTokenSource: async () => 'cli',
        ...change
    };
    return { setup: new SetupChecks(deps), commands };
}

describe('SetupChecks', () => {
    it('runs all checks in the order of the page', async () => {
        const results = await checks().setup.runAll();
        expect(results.map(result => result.id)).toEqual([...SETUP_CHECK_IDS]);
        expect(results.every(result => result.state === 'ok')).toBe(true);
    });

    it('checks the command of the default agent', async () => {
        const settings: AppSettings = { ...DEFAULT_SETTINGS, defaultAgentId: 'codex' };
        const { setup, commands } = checks({}, settings);
        const result = await setup.run('agent');
        expect(commands).toEqual(['codex']);
        expect(result.message).toBe('Codex is at /usr/bin/codex.');
    });

    it('maps the problems of each check', async () => {
        const { setup } = checks({
            checkCommand: async command => ({ program: command }),
            activeRepoCount: async () => 0,
            githubTokenSource: async () => undefined,
            settings: async () => ({ ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, enabled: false } })
        });
        const states = Object.fromEntries((await setup.runAll()).map(result => [result.id, result.state]));
        expect(states).toEqual({ git: 'missing', agent: 'warning', github: 'warning', repository: 'missing', notifications: 'warning' });
    });

    it('gives "unknown" for a check that fails, and runs the other checks', async () => {
        const { setup } = checks({
            githubTokenSource: async () => {
                throw new Error('The keychain is locked.');
            }
        });
        const results = await setup.runAll();
        expect(results.find(result => result.id === 'github')).toMatchObject({ state: 'unknown', message: expect.stringContaining('keychain') });
        expect(results.filter(result => result.state === 'ok')).toHaveLength(4);
    });
});
