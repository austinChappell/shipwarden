import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFICATION_SETTINGS } from './notifications';
import { DEFAULT_AGENTS } from './settings';
import {
    agentCheckResult,
    failedCheckResult,
    gitCheckResult,
    githubCheckResult,
    isSetupCheckId,
    notificationsCheckResult,
    replaceCheckResult,
    repositoryCheckResult,
    SETUP_CHECK_IDS
} from './setup-checks';

const claude = DEFAULT_AGENTS[0];

describe('gitCheckResult', () => {
    it('is ok when git is in the PATH', () => {
        expect(gitCheckResult({ program: 'git', path: '/usr/bin/git' })).toEqual({ id: 'git', state: 'ok', message: 'git is at /usr/bin/git.', fixes: [] });
    });

    it('is missing without git, and shows the install command', () => {
        const result = gitCheckResult({ program: 'git' });
        expect(result.state).toBe('missing');
        expect(result.fixes).toEqual([{ kind: 'command', label: 'Install git', command: 'xcode-select --install' }]);
    });
});

describe('agentCheckResult', () => {
    it('is ok when the program of the agent is in the PATH', () => {
        expect(agentCheckResult(claude, { program: 'claude', path: '/opt/homebrew/bin/claude' })).toMatchObject({
            id: 'agent',
            state: 'ok',
            message: 'Claude Code is at /opt/homebrew/bin/claude.',
            fixes: []
        });
    });

    it('gives a warning without the program, because an alias can start the agent', () => {
        const result = agentCheckResult(claude, { program: 'claude' });
        expect(result.state).toBe('warning');
        expect(result.message).toContain('"claude"');
        expect(result.fixes).toEqual([
            { kind: 'link', label: 'Install Claude Code', url: 'https://docs.anthropic.com/en/docs/claude-code/setup' },
            { kind: 'settings', label: 'Open Settings › Agents', section: 'agents' }
        ]);
    });

    it('finds the install page of a program with a folder', () => {
        const result = agentCheckResult({ id: 'x', name: 'Codex', command: '/opt/bin/codex --yolo' }, { program: '/opt/bin/codex' });
        expect(result.fixes[0]).toMatchObject({ kind: 'link', url: 'https://github.com/openai/codex' });
    });

    it('shows only the settings for an agent without an install page', () => {
        const result = agentCheckResult({ id: 'aider', name: 'Aider', command: 'aider' }, { program: 'aider' });
        expect(result.fixes).toEqual([{ kind: 'settings', label: 'Open Settings › Agents', section: 'agents' }]);
    });

    it('is missing when the agent has no command', () => {
        expect(agentCheckResult({ id: 'x', name: 'Empty', command: '' }, { program: '' }).state).toBe('missing');
    });
});

describe('githubCheckResult', () => {
    it('is ok with a token, and names the place of the token', () => {
        expect(githubCheckResult('cli')).toMatchObject({ state: 'ok', message: 'ShipWarden uses the GitHub CLI login for GitHub.' });
        expect(githubCheckResult('env').message).toContain('GITHUB_TOKEN');
        expect(githubCheckResult('saved').message).toContain('Settings › Code review');
    });

    it('gives a warning without a token, with the two fixes', () => {
        const result = githubCheckResult(undefined);
        expect(result.state).toBe('warning');
        expect(result.fixes.map(fix => fix.kind)).toEqual(['command', 'settings']);
        expect(result.fixes[0]).toMatchObject({ command: 'gh auth login' });
        expect(result.fixes[1]).toMatchObject({ section: 'review' });
    });
});

describe('repositoryCheckResult', () => {
    it('is ok with repositories', () => {
        expect(repositoryCheckResult(1)).toMatchObject({ state: 'ok', message: 'The project has 1 repository.' });
        expect(repositoryCheckResult(3).message).toBe('The project has 3 repositories.');
    });

    it('is missing without repositories, and offers to add or clone one', () => {
        const result = repositoryCheckResult(0);
        expect(result.state).toBe('missing');
        expect(result.fixes).toEqual([
            { kind: 'repository', label: 'Add a repository', action: 'add' },
            { kind: 'repository', label: 'Clone a repository', action: 'clone' }
        ]);
    });
});

describe('notificationsCheckResult', () => {
    it('is ok when notifications are on', () => {
        expect(notificationsCheckResult({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true }).state).toBe('ok');
    });

    it('gives a warning when notifications are off', () => {
        const result = notificationsCheckResult({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: false });
        expect(result.state).toBe('warning');
        expect(result.fixes).toEqual([{ kind: 'settings', label: 'Open Settings › Notifications', section: 'notifications' }]);
    });
});

describe('failedCheckResult', () => {
    it('is unknown and shows the error', () => {
        expect(failedCheckResult('github', new Error('The keychain is locked.'))).toEqual({
            id: 'github',
            state: 'unknown',
            message: 'ShipWarden cannot do this check. The keychain is locked.',
            fixes: []
        });
    });
});

describe('replaceCheckResult', () => {
    it('replaces one result and keeps the order', () => {
        const before = [gitCheckResult({ program: 'git' }), githubCheckResult(undefined)];
        const after = replaceCheckResult(before, githubCheckResult('cli'));
        expect(after.map(item => [item.id, item.state])).toEqual([
            ['git', 'missing'],
            ['github', 'ok']
        ]);
        expect(before[1].state).toBe('warning');
    });

    it('adds a result that is not in the list', () => {
        expect(replaceCheckResult([], repositoryCheckResult(1)).map(item => item.id)).toEqual(['repository']);
    });
});

describe('isSetupCheckId', () => {
    it('accepts only the IDs of the checks', () => {
        expect(SETUP_CHECK_IDS.every(isSetupCheckId)).toBe(true);
        expect(isSetupCheckId('network')).toBe(false);
        expect(isSetupCheckId(undefined)).toBe(false);
    });
});
