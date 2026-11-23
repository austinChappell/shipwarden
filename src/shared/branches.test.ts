import { describe, expect, it } from 'vitest';
import { bulkDeletable, localDeleteBlock, parseBranchRefs, remoteOf, withoutLocal, withoutRemote, type BranchDetails } from './branches';

const line = (...fields: string[]) => fields.join('\0');

describe('parseBranchRefs', () => {
    it('reads the local and remote branches and skips the HEAD of a remote', () => {
        const output = [
            line('refs/heads/main', 'aaa', '1700000000', 'origin/main', 'ahead 2, behind 1', '/repo', 'Fix: a bug'),
            line('refs/heads/feat/x', 'bbb', '1700000100', 'origin/feat/x', 'gone', '', 'Work'),
            line('refs/heads/solo', 'ccc', '1700000200', '', '', '/wt/solo', 'Solo'),
            line('refs/remotes/origin/HEAD', 'aaa', '1700000000', '', '', '', 'Fix: a bug'),
            line('refs/remotes/up/stream/main', 'ddd', '1700000300', '', '', '', 'Up')
        ].join('\n');
        const { local, remote } = parseBranchRefs(output, ['origin', 'up/stream']);
        expect(local).toEqual([
            { name: 'main', commit: 'aaa', date: 1_700_000_000_000, subject: 'Fix: a bug', upstream: 'origin/main', ahead: 2, behind: 1, worktree: '/repo' },
            { name: 'feat/x', commit: 'bbb', date: 1_700_000_100_000, subject: 'Work', upstream: 'origin/feat/x', gone: true },
            { name: 'solo', commit: 'ccc', date: 1_700_000_200_000, subject: 'Solo', worktree: '/wt/solo' }
        ]);
        expect(remote).toEqual([{ name: 'up/stream/main', remote: 'up/stream', branch: 'main', commit: 'ddd', date: 1_700_000_300_000, subject: 'Up' }]);
    });
});

describe('remoteOf', () => {
    it('picks the longest remote name', () => {
        expect(remoteOf('up/stream/main', ['up', 'up/stream'])).toBe('up/stream');
        expect(remoteOf('nowhere/main', ['origin'])).toBeUndefined();
    });
});

const details: BranchDetails = {
    mainWorktree: '/repo',
    defaultBranch: 'main',
    local: [
        { name: 'main', commit: 'a', date: 0, subject: '', worktree: '/repo' },
        { name: 'checked', commit: 'b', date: 0, subject: '', worktree: '/repo' },
        { name: 'in-tree', commit: 'c', date: 0, subject: '', worktree: '/wt/in-tree' },
        { name: 'free', commit: 'd', date: 0, subject: '', upstream: 'origin/free', ahead: 1 }
    ],
    remote: [{ name: 'origin/free', remote: 'origin', branch: 'free', commit: 'd', date: 0, subject: '' }]
};

describe('the delete rules', () => {
    it('keeps the default branch and the checked-out branches', () => {
        expect(localDeleteBlock(details.local[0], details)).toMatch(/default branch/);
        expect(localDeleteBlock(details.local[1], details)).toMatch(/main folder/);
        expect(localDeleteBlock(details.local[2], details)).toMatch(/worktree/);
        expect(localDeleteBlock(details.local[3], details)).toBeUndefined();
        expect(bulkDeletable(details).map(branch => branch.name)).toEqual(['free']);
    });
});

describe('the cache updates', () => {
    it('removes deleted local branches', () => {
        expect(withoutLocal(details, ['free', 'in-tree']).local.map(branch => branch.name)).toEqual(['main', 'checked']);
    });

    it('removes a deleted remote branch and marks its local branch as gone', () => {
        const next = withoutRemote(details, 'origin/free');
        expect(next.remote).toEqual([]);
        expect(next.local[3]).toEqual({ name: 'free', commit: 'd', date: 0, subject: '', upstream: 'origin/free', gone: true });
    });
});
