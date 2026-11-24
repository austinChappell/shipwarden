import { describe, expect, it } from 'vitest';
import type { RepoRef } from '@shared/github';
import { ProjectWorktrees, type ProjectWorktreesOptions } from './project-worktrees';

/** Returns a service with fake repositories, and counts the worktree reads. */
function service(change: Partial<ProjectWorktreesOptions> = {}) {
    const reads: string[] = [];
    const worktrees: Record<string, string[]> = {
        '/code/api': ['/code/api', '/trees/api-feature'],
        '/code/web': ['/code/web']
    };
    const remotes: Record<string, RepoRef> = { '/code/api': { owner: 'Acme', name: 'API' } };
    const projectWorktrees = new ProjectWorktrees({
        projectRepos: async () => ['/code/api', '/code/web', '/code/api'],
        worktreePaths: async repo => {
            reads.push(repo);
            if (repo === '/code/broken') throw new Error('Not a git repository.');
            return worktrees[repo] ?? [];
        },
        isReviewCheckout: async path => path === '/review/acme-api-7',
        repoFor: async root => remotes[root] ?? null,
        ...change
    });
    return { projectWorktrees, reads };
}

describe('ProjectWorktrees.check', () => {
    it('accepts a worktree of a project', async () => {
        const { projectWorktrees } = service();
        await expect(projectWorktrees.check('/trees/api-feature')).resolves.toBe('/trees/api-feature');
    });

    it('accepts the copy of a pull request', async () => {
        const { projectWorktrees, reads } = service();
        await expect(projectWorktrees.check('/review/acme-api-7')).resolves.toBe('/review/acme-api-7');
        expect(reads).toEqual([]);
    });

    it('rejects another folder', async () => {
        const { projectWorktrees } = service();
        await expect(projectWorktrees.check('/etc')).rejects.toThrow('"/etc" is not a worktree of a project.');
    });

    it('reads the worktrees again only for an unknown path', async () => {
        const { projectWorktrees, reads } = service();
        await projectWorktrees.check('/code/web');
        const count = reads.length;
        await projectWorktrees.check('/trees/api-feature');
        expect(reads.length).toBe(count);
    });

    it('ignores a repository that git cannot read', async () => {
        const { projectWorktrees } = service({ projectRepos: async () => ['/code/broken', '/code/web'] });
        await expect(projectWorktrees.check('/code/web')).resolves.toBe('/code/web');
    });
});

describe('ProjectWorktrees.localClone', () => {
    it('finds the repository with the GitHub remote and ignores the case', async () => {
        const { projectWorktrees } = service();
        await expect(projectWorktrees.localClone({ owner: 'acme', name: 'api' })).resolves.toBe('/code/api');
    });

    it('gives undefined without a clone', async () => {
        const { projectWorktrees } = service();
        await expect(projectWorktrees.localClone({ owner: 'acme', name: 'docs' })).resolves.toBeUndefined();
    });

    it('ignores a repository whose remote fails', async () => {
        const { projectWorktrees } = service({
            repoFor: async root => {
                if (root === '/code/api') throw new Error('No remote.');
                return { owner: 'acme', name: 'web' };
            }
        });
        await expect(projectWorktrees.localClone({ owner: 'acme', name: 'web' })).resolves.toBe('/code/web');
    });
});

describe('ProjectWorktrees.repoOf', () => {
    it('finds the repository of a worktree', async () => {
        const { projectWorktrees } = service();
        await expect(projectWorktrees.repoOf('/trees/api-feature')).resolves.toBe('/code/api');
        await expect(projectWorktrees.repoOf('/code/web')).resolves.toBe('/code/web');
    });

    it('gives undefined for another folder', async () => {
        const { projectWorktrees } = service();
        await expect(projectWorktrees.repoOf('/tmp')).resolves.toBeUndefined();
    });
});

describe('ProjectWorktrees.locate', () => {
    it('returns a worktree root and the absolute file path', async () => {
        const { projectWorktrees } = service();
        await expect(projectWorktrees.locate('/trees/api-feature', 'src/a.ts')).resolves.toEqual({
            worktree: '/trees/api-feature',
            absolute: '/trees/api-feature/src/a.ts'
        });
    });

    it('refuses a path outside the worktree root', async () => {
        const { projectWorktrees } = service();
        await expect(projectWorktrees.locate('/code/web', '../api/a.ts')).rejects.toThrow('outside the worktree');
    });

    it('finds the deepest worktree of a file under a folder that is not a worktree', async () => {
        const { projectWorktrees } = service({
            projectRepos: async () => ['/home/me/code/api'],
            worktreePaths: async () => ['/home/me/code/api', '/home/me/code/api/.trees/feature']
        });
        await expect(projectWorktrees.locate('/home/me', 'code/api/.trees/feature/src/a.ts')).resolves.toEqual({
            worktree: '/home/me/code/api/.trees/feature',
            absolute: '/home/me/code/api/.trees/feature/src/a.ts'
        });
        await expect(projectWorktrees.locate('/home/me', 'code/api/README.md')).resolves.toMatchObject({ worktree: '/home/me/code/api' });
    });

    it('refuses a file that is in no worktree', async () => {
        const { projectWorktrees } = service();
        await expect(projectWorktrees.locate('/home/me', '.zshrc')).rejects.toThrow('"/home/me/.zshrc" is not in a worktree of a project.');
    });
});
