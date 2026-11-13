import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findPullRequestTemplate, GitChangesService } from './git-changes-service';

describe('GitChangesService', () => {
    let repo: string;
    let trashed: string[] = [];
    const git = new GitChangesService(async file => {
        trashed.push(file);
        rmSync(file, { recursive: true, force: true });
    });
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();

    beforeEach(() => {
        trashed = [];
        repo = realpathSync(mkdtempSync(join(tmpdir(), 'shipwarden-git-')));
        sh('init', '-q', '-b', 'main');
        sh('config', 'user.name', 'Test');
        sh('config', 'user.email', 'test@example.com');
        sh('config', 'commit.gpgsign', 'false');
    });

    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    it('reads the history for the graph, with refs, and without remote branches on request', async () => {
        expect(await git.log(repo, 'all', 10)).toEqual({ commits: [], more: false });
        sh('commit', '-q', '--allow-empty', '-m', 'one');
        sh('commit', '-q', '--allow-empty', '-m', 'two');
        sh('branch', 'side', 'HEAD~1');
        sh('checkout', '-q', 'side');
        sh('commit', '-q', '--allow-empty', '-m', 'side work');
        sh('checkout', '-q', 'main');
        sh('tag', 'v1');

        const all = await git.log(repo, 'all', 10);
        expect(all.more).toBe(false);
        expect(all.commits.map(commit => commit.subject).sort()).toEqual(['one', 'side work', 'two']);
        const two = all.commits.find(commit => commit.subject === 'two');
        expect(two?.refs).toEqual([
            { name: 'main', kind: 'local', current: true },
            { name: 'v1', kind: 'tag' }
        ]);
        expect(two?.parents).toHaveLength(1);

        // A remote branch with a commit that no local branch has.
        sh('update-ref', 'refs/remotes/origin/far', sh('commit-tree', '-m', 'remote only', '-p', 'HEAD', 'HEAD^{tree}').trim());
        expect((await git.log(repo, 'all', 10)).commits.map(commit => commit.subject)).toContain('remote only');
        expect((await git.log(repo, 'local', 10)).commits.map(commit => commit.subject)).not.toContain('remote only');
        expect(await git.log(repo, 'all', 1)).toMatchObject({ more: true });
    });

    it('stages and unstages before the first commit, and makes the first commit', async () => {
        writeFileSync(join(repo, 'a.txt'), 'one\n');
        let status = await git.status(repo);
        expect(status.unborn).toBe(true);
        expect(status.unstaged).toEqual([{ path: 'a.txt', kind: 'untracked' }]);

        await git.stage(repo, ['a.txt']);
        expect((await git.status(repo)).staged).toEqual([{ path: 'a.txt', kind: 'added' }]);
        await git.unstage(repo, ['a.txt']);
        expect((await git.status(repo)).staged).toEqual([]);

        await git.stage(repo, ['a.txt']);
        const result = await git.commit(repo, 'First commit\n\nWith a body.');
        expect(result.summary).toBe('First commit');
        status = await git.status(repo);
        expect(status).toMatchObject({ branch: 'main', unborn: false, staged: [], unstaged: [] });
        expect(await git.lastMessage(repo)).toBe('First commit\n\nWith a body.');
    });

    it('gives the two versions of each side of a change, and stages a deleted file', async () => {
        writeFileSync(join(repo, 'a.txt'), 'one\n');
        writeFileSync(join(repo, 'b.txt'), 'bee\n');
        await git.stage(repo, ['a.txt', 'b.txt']);
        await git.commit(repo, 'Start');

        writeFileSync(join(repo, 'a.txt'), 'two\n');
        await git.stage(repo, ['a.txt']);
        writeFileSync(join(repo, 'a.txt'), 'three\n');
        expect(await git.contents(repo, 'a.txt', 'staged')).toEqual({ original: 'one\n', modified: 'two\n', binary: false });
        expect(await git.contents(repo, 'a.txt', 'unstaged')).toEqual({ original: 'two\n', modified: 'three\n', binary: false });

        unlinkSync(join(repo, 'b.txt'));
        expect((await git.status(repo)).unstaged).toContainEqual({ path: 'b.txt', kind: 'deleted' });
        expect(await git.contents(repo, 'b.txt', 'unstaged')).toEqual({ original: 'bee\n', modified: '', binary: false });
        await git.stage(repo, ['b.txt']);
        expect((await git.status(repo)).staged).toContainEqual({ path: 'b.txt', kind: 'deleted' });

        await git.commit(repo, 'Change a, remove b', false);
        await git.commit(repo, 'Change a, remove b (amended)', true);
        expect(sh('log', '--format=%s').trim().split('\n')).toEqual(['Change a, remove b (amended)', 'Start']);
    });

    it('refuses paths that leave the worktree and an empty message', async () => {
        await expect(git.stage(repo, ['../outside'])).rejects.toThrow(/not a path/);
        await expect(git.contents(repo, '/etc/hosts', 'unstaged')).rejects.toThrow(/not a path/);
        await expect(git.commit(repo, '   ')).rejects.toThrow(/Type a commit message/);
    });

    it('discards changes: untracked files and a copy of each changed file go to the Trash', async () => {
        writeFileSync(join(repo, 'a.txt'), 'one\n');
        await git.stage(repo, ['a.txt']);
        await git.commit(repo, 'Start');
        writeFileSync(join(repo, 'a.txt'), 'changed\n');
        writeFileSync(join(repo, 'new.txt'), 'new\n');

        await git.discard(repo, ['a.txt', 'new.txt']);
        expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\n');
        expect(existsSync(join(repo, 'new.txt'))).toBe(false);
        expect(trashed.map(file => basename(file))).toEqual(['new.txt', expect.stringMatching(/^a \(discarded .*\)\.txt$/)]);
        expect((await git.status(repo)).unstaged).toEqual([]);
    });

    it('pulls with a fast-forward only, and explains a refused pull', async () => {
        const remote = realpathSync(mkdtempSync(join(tmpdir(), 'shipwarden-remote-')));
        const other = realpathSync(mkdtempSync(join(tmpdir(), 'shipwarden-other-')));
        try {
            execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
            writeFileSync(join(repo, 'a.txt'), 'one\n');
            await git.stage(repo, ['a.txt']);
            await git.commit(repo, 'Start');
            sh('remote', 'add', 'origin', remote);
            await git.push(repo);
            expect((await git.status(repo)).upstream).toBe('origin/main');

            // Another clone pushes a commit.
            execFileSync('git', ['clone', '-q', remote, other]);
            const inOther = (...args: string[]) =>
                execFileSync('git', ['-c', 'user.name=O', '-c', 'user.email=o@example.com', ...args], { cwd: other, stdio: 'pipe' });
            writeFileSync(join(other, 'b.txt'), 'bee\n');
            inOther('add', 'b.txt');
            inOther('commit', '-q', '-m', 'Add b');
            inOther('push', '-q');

            // A background fetch finds the new commit. A second fetch within the time does nothing.
            const first = await git.fetch(repo, 60_000);
            expect(first.error).toBeUndefined();
            expect((await git.status(repo)).behind).toBe(1);
            expect((await git.fetch(repo, 60_000)).at).toBe(first.at);

            await git.pull(repo);
            expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('bee\n');

            // Both sides get a new commit: a fast-forward is not possible.
            writeFileSync(join(other, 'c.txt'), 'c\n');
            inOther('add', 'c.txt');
            inOther('commit', '-q', '-m', 'Add c');
            inOther('push', '-q');
            writeFileSync(join(repo, 'd.txt'), 'd\n');
            await git.stage(repo, ['d.txt']);
            await git.commit(repo, 'Add d');
            await expect(git.pull(repo)).rejects.toThrow(/both have new commits/);
        } finally {
            rmSync(remote, { recursive: true, force: true });
            rmSync(other, { recursive: true, force: true });
        }
    });

    it('collects the staged diff and the recent subjects for a commit message draft', async () => {
        await expect(git.commitDraftInput(repo, false)).rejects.toThrow('Stage changes first');
        writeFileSync(join(repo, 'a.txt'), 'one\n');
        sh('add', 'a.txt');
        // Before the first commit, there are no subjects.
        expect(await git.commitDraftInput(repo, false)).toMatchObject({ branch: 'main', recentSubjects: [] });
        sh('commit', '-q', '-m', 'feat: first');
        writeFileSync(join(repo, 'a.txt'), 'two\n');
        writeFileSync(join(repo, 'b.txt'), 'not staged\n');
        sh('add', 'a.txt');
        const input = await git.commitDraftInput(repo, false);
        expect(input.diff).toContain('+two');
        expect(input.diff).not.toContain('not staged');
        expect(input.stat).toContain('a.txt');
        expect(input.recentSubjects).toEqual(['feat: first']);
        expect(input.amendedMessage).toBeUndefined();
    });

    it('includes the changes of the last commit in an amend draft', async () => {
        writeFileSync(join(repo, 'a.txt'), 'one\n');
        sh('add', 'a.txt');
        sh('commit', '-q', '-m', 'first');
        // The amend of the first commit compares with the empty tree.
        const first = await git.commitDraftInput(repo, true);
        expect(first.diff).toContain('+one');
        expect(first.amendedMessage).toBe('first');
        writeFileSync(join(repo, 'b.txt'), 'two\n');
        sh('add', 'b.txt');
        sh('commit', '-q', '-m', 'second');
        const amend = await git.commitDraftInput(repo, true);
        expect(amend.diff).toContain('b.txt');
        expect(amend.diff).not.toContain('a.txt');
    });

    it('collects the commits, the diff and the template of the branch for a pull request draft', async () => {
        writeFileSync(join(repo, 'a.txt'), 'one\n');
        mkdirSync(join(repo, '.github'));
        writeFileSync(join(repo, '.github', 'PULL_REQUEST_TEMPLATE.md'), '## Summary\n');
        sh('add', '.');
        sh('commit', '-q', '-m', 'base');
        await expect(git.pullRequestDraftInput(repo)).rejects.toThrow('default branch');
        sh('update-ref', 'refs/remotes/origin/main', 'HEAD');
        sh('checkout', '-q', '-b', 'feature');
        await expect(git.pullRequestDraftInput(repo)).rejects.toThrow('no changes');
        writeFileSync(join(repo, 'a.txt'), 'two\n');
        sh('commit', '-q', '-am', 'Change a\n\nThe body.');
        const input = await git.pullRequestDraftInput(repo);
        expect(input).toMatchObject({
            branch: 'feature',
            base: 'origin/main',
            commits: ['Change a\n\nThe body.'],
            template: { path: '.github/PULL_REQUEST_TEMPLATE.md', text: '## Summary' }
        });
        expect(input.diff).toContain('+two');
    });

    it('finds a pull request template in a folder of templates, and ignores case', async () => {
        expect(await findPullRequestTemplate(repo)).toBeUndefined();
        mkdirSync(join(repo, 'docs', 'PULL_REQUEST_TEMPLATE'), { recursive: true });
        writeFileSync(join(repo, 'docs', 'PULL_REQUEST_TEMPLATE', 'b.md'), 'B');
        writeFileSync(join(repo, 'docs', 'PULL_REQUEST_TEMPLATE', 'a.md'), 'A');
        expect(await findPullRequestTemplate(repo)).toEqual({ path: 'docs/PULL_REQUEST_TEMPLATE/a.md', text: 'A' });
        writeFileSync(join(repo, 'pull_request_template.md'), 'Root');
        expect(await findPullRequestTemplate(repo)).toEqual({ path: 'pull_request_template.md', text: 'Root' });
    });
});
