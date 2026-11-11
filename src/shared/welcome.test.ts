import { describe, expect, it } from 'vitest';
import { failedCheckResult, gitCheckResult, githubCheckResult, notificationsCheckResult, type SetupCheckResult } from './setup-checks';
import { DEFAULT_NOTIFICATION_SETTINGS } from './notifications';
import { parseRepoInput, shouldOpenWelcome, welcomeStepStates } from './welcome';

const ok = (id: SetupCheckResult['id']): SetupCheckResult => ({ id, state: 'ok', message: '', fixes: [] });
const allOk = [ok('git'), ok('agent'), ok('github'), ok('repository'), ok('notifications')];

describe('shouldOpenWelcome', () => {
    it('opens the welcome page only for a new user', () => {
        expect(shouldOpenWelcome({ welcome: 'new' })).toBe(true);
        expect(shouldOpenWelcome({ welcome: 'done' })).toBe(false);
        expect(shouldOpenWelcome({ welcome: 'skipped' })).toBe(false);
        expect(shouldOpenWelcome(undefined)).toBe(false);
    });
});

describe('welcomeStepStates', () => {
    it('shows the tools as "to do" while the checks run', () => {
        expect(welcomeStepStates(undefined, 0)).toEqual({
            welcome: 'info',
            tools: 'todo',
            repository: 'todo',
            agent: 'todo',
            optional: 'info',
            start: 'blocked'
        });
    });

    it('marks the steps done when the setup is complete', () => {
        expect(welcomeStepStates(allOk, 1)).toMatchObject({ tools: 'done', repository: 'done', agent: 'done', start: 'todo' });
    });

    it('shows a problem when a tool is missing', () => {
        const checks = allOk.map(check => (check.id === 'git' ? gitCheckResult({ program: 'git' }) : check));
        expect(welcomeStepStates(checks, 1).tools).toBe('problem');
    });

    it('shows a warning for a warning or a failed check', () => {
        const noToken = allOk.map(check => (check.id === 'github' ? githubCheckResult(undefined) : check));
        expect(welcomeStepStates(noToken, 1).tools).toBe('warning');
        const off = allOk.map(check => (check.id === 'notifications' ? notificationsCheckResult({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: false }) : check));
        expect(welcomeStepStates(off, 1).tools).toBe('warning');
        const failed = allOk.map(check => (check.id === 'git' ? failedCheckResult('git', 'x') : check));
        expect(welcomeStepStates(failed, 1).tools).toBe('warning');
    });

    it('ignores the repository check in the tools step', () => {
        const checks = allOk.map(check => (check.id === 'repository' ? { ...check, state: 'missing' as const } : check));
        expect(welcomeStepStates(checks, 0)).toMatchObject({ tools: 'done', repository: 'todo' });
    });

    it('shows the state of the agent check in the agent step', () => {
        const warn = allOk.map(check => (check.id === 'agent' ? { ...check, state: 'warning' as const } : check));
        expect(welcomeStepStates(warn, 1).agent).toBe('warning');
        const missing = allOk.map(check => (check.id === 'agent' ? { ...check, state: 'missing' as const } : check));
        expect(welcomeStepStates(missing, 1).agent).toBe('problem');
    });

    it('waits for all tool checks', () => {
        expect(welcomeStepStates([ok('git')], 0).tools).toBe('todo');
    });
});

describe('parseRepoInput', () => {
    it('reads "owner/name"', () => {
        expect(parseRepoInput(' octo-org/my.repo ')).toEqual({ owner: 'octo-org', name: 'my.repo' });
        expect(parseRepoInput('octo/repo.git')).toEqual({ owner: 'octo', name: 'repo' });
    });

    it('reads GitHub addresses', () => {
        expect(parseRepoInput('https://github.com/octo/repo')).toEqual({ owner: 'octo', name: 'repo' });
        expect(parseRepoInput('https://github.com/octo/repo.git')).toEqual({ owner: 'octo', name: 'repo' });
        expect(parseRepoInput('git@github.com:octo/repo.git')).toEqual({ owner: 'octo', name: 'repo' });
        expect(parseRepoInput('github.com/octo/repo')).toEqual({ owner: 'octo', name: 'repo' });
        expect(parseRepoInput('www.github.com/octo/repo')).toEqual({ owner: 'octo', name: 'repo' });
    });

    it('rejects other text', () => {
        expect(parseRepoInput('')).toBeUndefined();
        expect(parseRepoInput('repo')).toBeUndefined();
        expect(parseRepoInput('a/b/c')).toBeUndefined();
        expect(parseRepoInput('octo/..')).toBeUndefined();
        expect(parseRepoInput('https://gitlab.com/octo/repo')).toBeUndefined();
        expect(parseRepoInput('octo/repo name')).toBeUndefined();
    });
});
