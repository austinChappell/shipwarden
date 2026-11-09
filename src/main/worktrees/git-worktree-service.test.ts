import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitWorktreeService } from './git-worktree-service';

describe('GitWorktreeService', () => {

    let tmp: string;
    let repo: string;
    let service: GitWorktreeService;

    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

    beforeEach(async () => {
        tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-test-')));
        repo = path.join(tmp, 'my-repo');
        await fs.mkdir(repo);
        git(repo, 'init', '-q', '-b', 'main');
        git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
        process.env.SHIPWARDEN_WORKTREES_DIR = path.join(tmp, 'worktrees');
        service = new GitWorktreeService();
    });

    afterEach(async () => {
        delete process.env.SHIPWARDEN_WORKTREES_DIR;
        await fs.rm(tmp, { recursive: true, force: true });
    });

    it('lists the local and remote branches and the default start point', async () => {
        const origin = path.join(tmp, 'origin.git');
        git(tmp, 'clone', '-q', '--bare', repo, origin);
        git(repo, 'remote', 'add', 'origin', origin);
        git(repo, 'branch', 'feature/a');
        const branches = await service.branches(repo);
        expect(branches.defaultBase).toBe('origin/main');
        expect(branches.local.sort()).toEqual(['feature/a', 'main']);
        expect(branches.remote).toEqual(['origin/main']);
        expect(branches.remotes).toEqual(['origin']);
    });

    it('checks out a remote branch into a new local branch that tracks it', async () => {
        const origin = path.join(tmp, 'origin.git');
        git(tmp, 'clone', '-q', '--bare', repo, origin);
        git(repo, 'remote', 'add', 'origin', origin);
        const other = path.join(tmp, 'other');
        git(tmp, 'clone', '-q', origin, other);
        git(other, 'checkout', '-q', '-b', 'feature/remote');
        git(other, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'remote work');
        git(other, 'push', '-q', 'origin', 'feature/remote');
        git(repo, 'fetch', '-q', 'origin');

        const worktree = await service.create({ repoPath: repo, branch: 'feature/remote', trackRef: 'origin/feature/remote', baseRef: 'main' });

        expect(worktree.branch).toBe('feature/remote');
        expect(git(worktree.path, 'log', '-1', '--format=%s').trim()).toBe('remote work');
        expect(git(repo, 'rev-parse', '--abbrev-ref', 'feature/remote@{upstream}').trim()).toBe('origin/feature/remote');
    });

    it('rejects a remote branch that does not exist', async () => {
        await expect(service.create({ repoPath: repo, branch: 'missing', trackRef: 'origin/missing' })).rejects.toThrow(/does not exist/);
    });

    it('starts a new branch from a chosen base', async () => {
        git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'second');
        git(repo, 'branch', 'older', 'HEAD~1');
        const worktree = await service.create({ repoPath: repo, branch: 'from-older', baseRef: 'older' });
        expect(git(worktree.path, 'log', '--format=%s').trim().split('\n')).toEqual(['init']);
    });

    it('lists the main worktree', async () => {
        const worktrees = await service.list(repo);
        expect(worktrees).toHaveLength(1);
        expect(worktrees[0]).toMatchObject({ path: repo, branch: 'main', isMain: true });
    });

    it('creates a worktree with a new branch in the worktrees folder', async () => {
        const worktree = await service.create({ repoPath: repo, branch: 'feature/login' });

        expect(worktree).toMatchObject({
            path: path.join(tmp, 'worktrees', 'my-repo', 'feature-login'),
            branch: 'feature/login',
            isMain: false
        });
        expect(await service.list(repo)).toHaveLength(2);
    });

    it('creates a worktree for a branch that exists', async () => {
        git(repo, 'branch', 'existing');
        const worktree = await service.create({ repoPath: repo, branch: 'existing' });
        expect(worktree.branch).toBe('existing');
    });

    it('starts a new branch from the newest default branch of origin, without tracking', async () => {
        // "origin" is a bare clone. A second clone pushes a commit to it, so the local main is behind.
        const origin = path.join(tmp, 'origin.git');
        git(tmp, 'clone', '-q', '--bare', repo, origin);
        git(repo, 'remote', 'add', 'origin', origin);
        git(repo, 'fetch', '-q', 'origin');
        const other = path.join(tmp, 'other');
        git(tmp, 'clone', '-q', origin, other);
        git(other, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'newer');
        git(other, 'push', '-q', 'origin', 'main');
        const newest = git(other, 'rev-parse', 'HEAD').trim();

        const worktree = await service.create({ repoPath: repo, branch: 'feature/new' });

        expect(worktree.head).toBe(newest);
        // Without tracking, the branch has no upstream. "git config --get" exits with code 1 for a missing key.
        expect(() => git(repo, 'config', '--get', 'branch.feature/new.merge')).toThrow();
    });

    it('rejects a branch name that is not valid', async () => {
        await expect(service.create({ repoPath: repo, branch: 'bad..name' })).rejects.toThrow('check-ref-format');
    });

    it('removes a worktree and keeps the branch', async () => {
        const worktree = await service.create({ repoPath: repo, branch: 'temp' });
        await service.remove(repo, worktree.path);

        expect(await service.list(repo)).toHaveLength(1);
        expect(git(repo, 'branch', '--list', 'temp').trim()).toContain('temp');
    });

    it('does not remove the main worktree', async () => {
        await expect(service.remove(repo, repo)).rejects.toThrow('does not remove the main worktree');
    });

    it('creates a worktree in the given parent folder', async () => {
        const parent = path.join(tmp, 'custom-trees');
        const worktree = await service.create({ repoPath: repo, branch: 'feat/x' }, parent);
        expect(worktree.path).toBe(path.join(parent, 'feat-x'));
    });

    it('copies the git-ignored files that match the patterns, and nothing else', async () => {
        await fs.writeFile(path.join(repo, '.gitignore'), '.env*\nnode_modules/\nsecret.key\n');
        git(repo, 'add', '.gitignore');
        git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'ignore');
        await fs.writeFile(path.join(repo, '.env'), 'TOKEN=1');
        await fs.mkdir(path.join(repo, 'apps/web'), { recursive: true });
        await fs.writeFile(path.join(repo, 'apps/web/.env.local'), 'X=2');
        await fs.mkdir(path.join(repo, 'node_modules/pkg'), { recursive: true });
        await fs.writeFile(path.join(repo, 'node_modules/pkg/index.js'), '');
        await fs.writeFile(path.join(repo, 'secret.key'), 'k');

        const matching = { enabled: true, mode: 'matching' as const, patterns: ['.env', '.env.*'], exclude: [] };
        expect(await service.ignoredMatches(repo, matching)).toEqual(['.env', 'apps/web/.env.local']);
        expect(await service.ignoredMatches(repo, { ...matching, mode: 'allExcept', exclude: ['node_modules/'] }))
            .toEqual(['.env', 'apps/web/.env.local', 'secret.key']);
        const worktree = await service.create({ repoPath: repo, branch: 'feat/copy' });
        const copied = await service.copyIgnored(repo, worktree.path, matching);
        expect(copied).toEqual(['.env', 'apps/web/.env.local']);
        expect(await fs.readFile(path.join(worktree.path, 'apps/web/.env.local'), 'utf8')).toBe('X=2');
        await expect(fs.access(path.join(worktree.path, 'node_modules'))).rejects.toThrow();
        await expect(fs.access(path.join(worktree.path, 'secret.key'))).rejects.toThrow();
        expect(await service.uncommittedChanges(worktree.path)).toBe('');
    });

    it('deletes a merged branch, and a branch with new commits only with force', async () => {
        const merged = await service.create({ repoPath: repo, branch: 'feat/merged' });
        await service.remove(repo, merged.path);
        expect(await service.deleteBranch(repo, 'feat/merged')).toEqual({ deleted: true });

        const work = await service.create({ repoPath: repo, branch: 'feat/work' });
        git(work.path, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'work');
        await service.remove(repo, work.path);
        expect(await service.deleteBranch(repo, 'feat/work')).toEqual({ deleted: false, notMerged: true });
        expect(await service.deleteBranch(repo, 'feat/work', true)).toEqual({ deleted: true });
        expect(git(repo, 'branch', '--list', 'feat/*').trim()).toBe('');
    });
});
