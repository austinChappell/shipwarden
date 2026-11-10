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
        githubRepoFor: async root => remotes[root] ?? null,
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
            githubRepoFor: async root => {
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
