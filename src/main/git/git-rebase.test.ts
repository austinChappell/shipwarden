import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasDiverged } from '@shared/git';
import { GitChangesService } from './git-changes-service';

describe('GitChangesService rebase', () => {
    let remote: string;
    let repo: string;
    let other: string;
    const git = new GitChangesService(async file => rmSync(file, { recursive: true, force: true }));
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();
    const inOther = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=O', '-c', 'user.email=o@example.com', ...args], { cwd: other, stdio: 'pipe' }).toString();
    const head = () => sh('rev-parse', 'HEAD').trim();
    const subjects = () => sh('log', '--format=%s').trim().split('\n');

    /** Another clone changes a file on main and pushes. */
    const pushToMain = (file: string, text: string, subject: string) => {
        inOther('pull', '-q', '--ff-only');
        writeFileSync(join(other, file), text);
        inOther('add', file);
        inOther('commit', '-q', '-m', subject);
        inOther('push', '-q', 'origin', 'main');
    };

    /** Commits a file on the branch of the repository. */
    const commit = (file: string, text: string, subject: string) => {
        writeFileSync(join(repo, file), text);
        sh('add', file);
        sh('commit', '-q', '-m', subject);
    };

    /** Makes a conflict: main and the branch change the same line of a.txt. */
    const makeConflict = () => {
        pushToMain('a.txt', 'one\nTWO from main\nthree\n', 'Change two on main');
        commit('a.txt', 'one\ntwo from feature\nthree\n', 'Change two on feature');
    };

    beforeEach(() => {
        remote = realpathSync(mkdtempSync(join(tmpdir(), 'shipwarden-rebase-remote-')));
        repo = realpathSync(mkdtempSync(join(tmpdir(), 'shipwarden-rebase-')));
        other = realpathSync(mkdtempSync(join(tmpdir(), 'shipwarden-rebase-other-')));
        execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
        sh('init', '-q', '-b', 'main');
        sh('config', 'user.name', 'Test');
        sh('config', 'user.email', 'test@example.com');
        sh('config', 'commit.gpgsign', 'false');
        commit('a.txt', 'one\ntwo\nthree\n', 'Start');
        sh('remote', 'add', 'origin', remote);
        sh('push', '-q', '-u', 'origin', 'main');
        execFileSync('git', ['clone', '-q', remote, other]);
        sh('checkout', '-q', '-b', 'feature');
    });

    afterEach(() => {
        for (const folder of [remote, repo, other]) rmSync(folder, { recursive: true, force: true });
    });

    it('rebases cleanly onto the default branch, and pushes with a lease after the rebase', async () => {
        commit('c.txt', 'c\n', 'Add c');
        sh('push', '-q', '-u', 'origin', 'feature');
        pushToMain('b.txt', 'b\n', 'Add b on main');

        expect(await git.defaultBranch(repo)).toBe('main');
        const result = await git.rebase(repo);
        expect(result).toEqual({ status: 'done', onto: 'origin/main', changed: true });
        expect(subjects()).toEqual(['Add c', 'Add b on main', 'Start']);

        // The rebase does not push. The branch and its upstream have different commits now.
        const after = await git.status(repo);
        expect(after.rebase).toBeUndefined();
        expect(hasDiverged(after)).toBe(true);
        await git.pushWithLease(repo);
        const pushed = await git.status(repo);
        expect([pushed.ahead, pushed.behind]).toEqual([0, 0]);
        expect(execFileSync('git', ['rev-parse', 'feature'], { cwd: remote }).toString().trim()).toBe(head());

        // A second rebase has nothing to do.
        expect(await git.rebase(repo)).toEqual({ status: 'done', onto: 'origin/main', changed: false });
    });

    it('refuses uncommitted changes and does not stash them, but accepts new files', async () => {
        commit('c.txt', 'c\n', 'Add c');
        writeFileSync(join(repo, 'a.txt'), 'changed\n');
        await expect(git.rebase(repo)).rejects.toThrow(/uncommitted changes/);
        expect(sh('stash', 'list')).toBe('');
        sh('checkout', '--', 'a.txt');
        writeFileSync(join(repo, 'new.txt'), 'new\n');
        expect((await git.rebase(repo)).status).toBe('done');
    });

    it('refuses a rebase onto a branch that does not exist or a name that is not a branch', async () => {
        await expect(git.rebase(repo, 'nope')).rejects.toThrow(/does not exist/);
        await expect(git.rebase(repo, '--exec=x')).rejects.toThrow(/not a branch name/);
    });

    it('stops on a conflict, gives the data for the agent, and continues after the resolution', async () => {
        makeConflict();
        const result = await git.rebase(repo);
        expect(result.status).toBe('conflict');
        if (result.status !== 'conflict') return;
        expect(result.state).toMatchObject({ branch: 'feature', ontoName: 'origin/main', step: 1, total: 1 });
        expect(result.state.stopped?.subject).toBe('Change two on feature');

        const status = await git.status(repo);
        expect(status.rebase?.ontoName).toBe('origin/main');
        expect(status.conflicted.map(change => change.path)).toEqual(['a.txt']);

        const input = await git.rebaseConflictInput(repo);
        expect(input).toMatchObject({ branch: 'feature', onto: 'origin/main', files: ['a.txt'] });
        expect(input.branchCommits).toHaveLength(1);
        expect(input.branchCommits[0]).toMatch(/^[0-9a-f]{7,} Change two on feature$/);
        expect(input.baseCommits[0]).toMatch(/ Change two on main$/);

        // Continue needs the resolved files in the index.
        await expect(git.rebaseContinue(repo)).rejects.toThrow(/Resolve and stage the files with conflicts first: a.txt/);
        writeFileSync(join(repo, 'a.txt'), 'one\nTWO from main and feature\nthree\n');
        await git.stage(repo, ['a.txt']);
        expect(await git.rebaseContinue(repo)).toEqual({ status: 'done', onto: 'origin/main', changed: true });
        expect((await git.status(repo)).rebase).toBeUndefined();
        // The editor of "git rebase --continue" keeps the message of the commit.
        expect(subjects()).toEqual(['Change two on feature', 'Change two on main', 'Start']);
    });

    it('stops again when the next commit has a conflict', async () => {
        pushToMain('a.txt', 'ONE\ntwo\nTHREE\n', 'Change one and three on main');
        commit('a.txt', 'one feature\ntwo\nthree\n', 'Change one on feature');
        commit('a.txt', 'one feature\ntwo\nthree feature\n', 'Change three on feature');
        const first = await git.rebase(repo);
        expect(first.status === 'conflict' && first.state.step).toBe(1);
        writeFileSync(join(repo, 'a.txt'), 'ONE feature\ntwo\nTHREE\n');
        await git.stage(repo, ['a.txt']);
        const second = await git.rebaseContinue(repo);
        expect(second.status).toBe('conflict');
        expect(second.status === 'conflict' && second.state).toMatchObject({ step: 2, total: 2, stopped: { subject: 'Change three on feature' } });
    });

    it('aborts a rebase, and the branch gets its commits again', async () => {
        makeConflict();
        const before = head();
        expect((await git.rebase(repo)).status).toBe('conflict');
        await git.rebaseAbort(repo);
        expect((await git.status(repo)).rebase).toBeUndefined();
        expect(head()).toBe(before);
        await expect(git.rebaseAbort(repo)).rejects.toThrow(/No rebase is in progress/);
    });

    it('finds a rebase that started outside ShipWarden, and skips its commit', async () => {
        makeConflict();
        sh('fetch', '-q', 'origin');
        expect(() => sh('rebase', 'origin/main')).toThrow();

        const status = await git.status(repo);
        expect(status.rebase).toMatchObject({ branch: 'feature', ontoName: 'origin/main' });
        await expect(git.rebase(repo)).rejects.toThrow(/already in progress/);

        expect(await git.rebaseSkip(repo)).toEqual({ status: 'done', onto: 'origin/main', changed: true });
        expect((await git.status(repo)).rebase).toBeUndefined();
        expect(subjects()).toEqual(['Change two on main', 'Start']);
    });

    it('finds a rebase of the apply backend', async () => {
        makeConflict();
        sh('fetch', '-q', 'origin');
        expect(() => sh('rebase', '--apply', 'origin/main')).toThrow();
        expect((await git.status(repo)).rebase).toMatchObject({ branch: 'feature', ontoName: 'origin/main', step: 1, total: 1 });
        await git.rebaseAbort(repo);
        expect((await git.status(repo)).rebase).toBeUndefined();
    });
    describe('a stacked branch after its parent merged', () => {
        /** The commits of the branch that origin/main does not have. */
        const ownSubjects = () => sh('log', '--format=%s', 'origin/main..HEAD').trim().split('\n');

        /**
         * "feature" is the parent. It changes line two of a.txt two times. "child" starts from it and adds c.txt.
         * Returns the tip of the parent when the child branched: the old base of the child.
         */
        const makeStack = (): string => {
            commit('a.txt', 'one\nTWO v1\nthree\n', 'Parent one');
            commit('a.txt', 'one\nTWO v2\nthree\n', 'Parent two');
            sh('push', '-q', '-u', 'origin', 'feature');
            const oldBase = head();
            sh('checkout', '-q', '-b', 'child');
            commit('c.txt', 'c\n', 'Child');
            sh('push', '-q', '-u', 'origin', 'child');
            inOther('fetch', '-q', 'origin');
            inOther('pull', '-q', '--ff-only');
            return oldBase;
        };

        it('moves only the commits of the child onto main after a regular merge', async () => {
            const oldBase = makeStack();
            inOther('merge', '-q', '--no-ff', '-m', 'Merge parent', 'origin/feature');
            inOther('push', '-q', 'origin', 'main');

            const result = await git.rebase(repo, 'main', [oldBase]);
            expect(result).toEqual({ status: 'done', onto: 'origin/main', changed: true });
            expect(ownSubjects()).toEqual(['Child']);
            expect(sh('rev-parse', 'HEAD~1').trim()).toBe(sh('rev-parse', 'origin/main').trim());
        });

        it('moves only the commits of the child onto main after a squash merge', async () => {
            const oldBase = makeStack();
            inOther('merge', '-q', '--squash', 'origin/feature');
            inOther('commit', '-q', '-m', 'Parent (#1)');
            inOther('push', '-q', 'origin', 'main');

            // A usual rebase replays the commits of the parent again, and the first one has a conflict.
            expect((await git.rebase(repo, 'main')).status).toBe('conflict');
            await git.rebaseAbort(repo);

            // An unknown commit does not count. The old base of the child gives "git rebase --onto".
            const result = await git.rebase(repo, 'main', ['0123456789abcdef0123456789abcdef01234567', oldBase]);
            expect(result).toEqual({ status: 'done', onto: 'origin/main', changed: true });
            expect(ownSubjects()).toEqual(['Child']);
            expect(subjects()).toEqual(['Child', 'Parent (#1)', 'Start']);
            expect(sh('show', 'HEAD:a.txt')).toBe('one\nTWO v2\nthree\n');
        });

        it('uses the newest old base when the child has later commits of the parent', async () => {
            const oldBase = makeStack();
            // The parent gets a fix, and the child merges it.
            sh('checkout', '-q', 'feature');
            commit('d.txt', 'd\n', 'Parent fix');
            sh('push', '-q', 'origin', 'feature');
            const parentTip = head();
            sh('checkout', '-q', 'child');
            sh('merge', '-q', '--no-edit', 'feature');
            sh('push', '-q', 'origin', 'child');
            inOther('fetch', '-q', 'origin');
            inOther('merge', '-q', '--squash', 'origin/feature');
            inOther('commit', '-q', '-m', 'Parent (#1)');
            inOther('push', '-q', 'origin', 'main');

            const result = await git.rebase(repo, 'main', [oldBase, parentTip]);
            expect(result.status).toBe('done');
            expect(ownSubjects()).toEqual(['Child']);
        });

        it('refuses an old base that is not a commit hash', async () => {
            await expect(git.rebase(repo, 'main', ['--exec=x'])).rejects.toThrow(/not a commit hash/);
        });
    });
});
