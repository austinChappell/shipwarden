import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitChangesService } from './git-changes-service';

describe('GitChangesService', () => {
    let repo: string;
    const git = new GitChangesService();
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();

    beforeEach(() => {
        repo = realpathSync(mkdtempSync(join(tmpdir(), 'shipwarden-git-')));
        sh('init', '-q', '-b', 'main');
        sh('config', 'user.name', 'Test');
        sh('config', 'user.email', 'test@example.com');
        sh('config', 'commit.gpgsign', 'false');
    });

    afterEach(() => rmSync(repo, { recursive: true, force: true }));

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
});
