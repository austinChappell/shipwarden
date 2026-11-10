import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, promises as fs, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReviewCheckouts } from './review-checkouts';

describe('ReviewCheckouts', () => {
    let tmp: string;
    let origin: string;
    let local: string;
    let folder: string;
    let now: number;
    let clone: string | undefined;

    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const commit = (cwd: string, file: string, text: string) => {
        writeFileSync(path.join(cwd, file), text);
        git(cwd, 'add', file);
        git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', `change ${file}`);
        return git(cwd, 'rev-parse', 'HEAD');
    };
    const make = () =>
        new ReviewCheckouts({
            folder,
            indexFile: path.join(tmp, 'index.json'),
            findClone: async () => clone,
            now: () => now
        });

    /** Pushes a new commit to the ref of pull request 7 in the origin, as GitHub does. Returns the commit. */
    const pushPullHead = (text: string) => {
        const work = path.join(tmp, 'author');
        if (!existsSync(work)) {
            git(tmp, 'clone', '-q', origin, work);
            git(work, 'checkout', '-q', '-b', 'feature');
        }
        const sha = commit(work, 'feature.ts', text);
        git(work, 'push', '-q', '--force', 'origin', 'HEAD:refs/pull/7/head');
        return sha;
    };

    beforeEach(async () => {
        tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-review-test-')));
        const seed = path.join(tmp, 'seed');
        await fs.mkdir(seed);
        git(seed, 'init', '-q', '-b', 'main');
        commit(seed, 'main.ts', 'export const a = 1;');
        origin = path.join(tmp, 'origin.git');
        git(tmp, 'clone', '-q', '--bare', seed, origin);
        local = path.join(tmp, 'local');
        git(tmp, 'clone', '-q', origin, local);
        folder = path.join(tmp, 'review');
        now = 1_000_000;
        clone = local;
    });

    afterEach(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    it('fetches the head of the pull request and adds a detached worktree at it', async () => {
        const sha = pushPullHead('export const b = 2;');
        const checkouts = make();

        const checkout = await checkouts.ensure({ owner: 'Octo', name: 'App' }, 7, sha, false);

        expect(checkout).toEqual({ root: path.join(folder, 'octo', 'app', 'pr-7'), sha });
        expect(git(checkout.root, 'rev-parse', 'HEAD')).toBe(sha);
        expect(await fs.readFile(path.join(checkout.root, 'feature.ts'), 'utf8')).toBe('export const b = 2;');
        // The user's clone gets no branch for the pull request.
        expect(git(local, 'branch', '--list')).toBe('* main');
        expect(await checkouts.has(checkout.root)).toBe(true);
        expect(checkouts.isInFolder(checkout.root)).toBe(true);
        expect(checkouts.isInFolder(local)).toBe(false);
        expect(await checkouts.status({ owner: 'octo', name: 'app' }, 7)).toEqual({ checkout, needsClone: false });
    });

    it('moves the worktree to a new head commit and keeps untracked files', async () => {
        const checkouts = make();
        const first = await checkouts.ensure({ owner: 'octo', name: 'app' }, 7, pushPullHead('one'), false);
        await fs.writeFile(path.join(first.root, 'untracked.txt'), 'keep');

        const sha = pushPullHead('two');
        const second = await checkouts.ensure({ owner: 'octo', name: 'app' }, 7, sha, false);

        expect(second.root).toBe(first.root);
        expect(git(second.root, 'rev-parse', 'HEAD')).toBe(sha);
        expect(await fs.readFile(path.join(second.root, 'feature.ts'), 'utf8')).toBe('two');
        expect(await fs.readFile(path.join(second.root, 'untracked.txt'), 'utf8')).toBe('keep');
    });

    it('rejects a commit that is not the head of the pull request', async () => {
        pushPullHead('one');
        const checkouts = make();

        await expect(checkouts.ensure({ owner: 'octo', name: 'app' }, 7, 'a'.repeat(40), false)).rejects.toThrow('is not the head of pull request #7 now');
    });

    it('needs a clone when no project has the repository', async () => {
        clone = undefined;
        const checkouts = make();

        expect(await checkouts.status({ owner: 'octo', name: 'app' }, 7)).toEqual({ needsClone: true });
        await expect(checkouts.ensure({ owner: 'octo', name: 'app' }, 7, 'a'.repeat(40), false)).rejects.toThrow('ShipWarden must clone the repository first');
    });

    it('removes the checkouts that the user did not open for some time', async () => {
        const checkouts = make();
        const old = await checkouts.ensure({ owner: 'octo', name: 'app' }, 7, pushPullHead('one'), false);
        now += 8 * 24 * 60 * 60_000;

        expect(await checkouts.prune()).toEqual([old.root]);

        await expect(fs.access(old.root)).rejects.toThrow();
        expect(git(local, 'worktree', 'list', '--porcelain')).not.toContain('pr-7');
        expect(await checkouts.has(old.root)).toBe(false);
    });

    it('keeps the checkouts that the user opened recently', async () => {
        const checkouts = make();
        await checkouts.ensure({ owner: 'octo', name: 'app' }, 7, pushPullHead('one'), false);
        now += 60_000;

        expect(await checkouts.prune()).toEqual([]);
    });
});
