import { describe, expect, it } from 'vitest';
import type { RemoteAgent, RemoteProject, RemoteRepo } from '@shared/remote';
import { worktreesFromSnapshot } from './worktree-list';

const repo = (path: string, worktrees: string[]): RemoteRepo => ({
    path,
    name: path,
    worktrees: worktrees.map(item => ({ path: item, name: item.split('/').pop() ?? item, branch: `b-${item.split('/').pop()}`, isMain: item === path }))
});
const r1 = repo('/r1', ['/r1', '/r1-a']);
const projects: RemoteProject[] = [
    { id: 'p1', name: 'One', repos: [r1] },
    // The same repository in a second project shows one time.
    { id: 'p2', name: 'Two', repos: [{ ...r1, worktrees: [...r1.worktrees] }, repo('/r2', ['/r2'])] }
];
r1.worktrees[1].task = { title: 'Fix it', key: 'ENG-1' };
r1.worktrees[1].pullRequest = { number: 4, title: 'Fix', url: 'https://x/4', isDraft: false, reviewDecision: null, checks: 'SUCCESS', headSha: 'abc' };
const agents: RemoteAgent[] = [
    { id: 's1', title: 'Claude Code', worktreePath: '/r1-a', cwd: '/r1-a', state: 'waiting', reason: 'Waiting for a permission prompt', exited: false },
    { id: 's2', title: 'Old', worktreePath: '/r1-a', cwd: '/r1-a', exited: true }
];

describe('worktreesFromSnapshot', () => {
    it('lists the repository of the caller with tasks, pull requests, and running agents', () => {
        expect(worktreesFromSnapshot({ projects, agents }, '/r1-a', false)).toEqual([
            { path: '/r1', branch: 'b-r1', name: 'r1', repo: '/r1', isMain: true, agents: [] },
            {
                path: '/r1-a',
                branch: 'b-r1-a',
                name: 'r1-a',
                repo: '/r1',
                isMain: false,
                task: { title: 'Fix it', key: 'ENG-1' },
                pullRequest: { number: 4, title: 'Fix', url: 'https://x/4', isDraft: false, reviewDecision: null, checks: 'SUCCESS' },
                agents: [{ title: 'Claude Code', state: 'waiting', message: 'Waiting for a permission prompt' }]
            }
        ]);
    });

    it('lists all repositories one time with "all"', () => {
        expect(worktreesFromSnapshot({ projects, agents }, '/r1-a', true).map(item => item.path)).toEqual(['/r1', '/r1-a', '/r2']);
    });
});
