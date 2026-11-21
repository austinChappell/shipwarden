import { describe, expect, it } from 'vitest';
import type { RemoteProject } from '@shared/remote';
import type { TerminalSession } from '@shared/terminal';
import { agentOf, checkOf, checksByWorktree } from './remote-snapshot';

const now = 1_000_000;
const session: TerminalSession = { id: 's1', title: 'Claude Code', cwd: '/w/a', worktreePath: '/w/a', isAgent: true, exited: false };

describe('agentOf', () => {
    it('gives the reason why the agent does not work', () => {
        expect(agentOf({ ...session, agentState: 'waiting', agentWaitFor: 'permission' }, undefined, now).reason).toBe('Waiting for a permission prompt');
        expect(agentOf({ ...session, agentState: 'done' }, 'PENDING', now).reason).toBe('Waiting for CI');
        expect(agentOf({ ...session, agentState: 'done' }, 'FAILURE', now).reason).toBe('CI failed. Waiting for your reply');
        expect(agentOf({ ...session, agentState: 'exited', exited: true, exitCode: 1 }, undefined, now).reason).toBe('The process stopped with an error');
    });

    it('sends no reason while the agent works', () => {
        expect(agentOf({ ...session, agentState: 'working' }, 'FAILURE', now)).not.toHaveProperty('reason');
    });
});

describe('checksByWorktree', () => {
    it('finds the checks of the pull request of a session worktree', () => {
        const pullRequest = { number: 1, url: 'u', isDraft: false, reviewDecision: null };
        const projects: RemoteProject[] = [
            {
                id: 'p',
                name: 'Work',
                repos: [
                    {
                        path: '/code/api',
                        name: 'api',
                        worktrees: [
                            { path: '/w/a', name: 'a', isMain: false, pullRequest: { ...pullRequest, checks: 'PENDING' } },
                            { path: '/w/b', name: 'b', isMain: false, pullRequest: { ...pullRequest, checks: null } },
                            { path: '/w/c', name: 'c', isMain: false }
                        ]
                    }
                ]
            }
        ];
        const checks = checksByWorktree(projects);
        expect(checkOf(checks, session)).toBe('PENDING');
        expect(checkOf(checks, { ...session, worktreePath: '/w/b' })).toBeNull();
        expect(checkOf(checks, { ...session, worktreePath: '/w/c' })).toBeUndefined();
        expect(checkOf(checks, { ...session, worktreePath: undefined })).toBeUndefined();
    });
});
