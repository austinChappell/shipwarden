import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CHECKPOINT_MAX_AGE_MS } from '@shared/checkpoints';
import { createCheckpoint, listCheckpoints, previewRewind, pruneCheckpoints, removeWorktreeCheckpoints, rewindToCheckpoint } from './checkpoints';

describe('checkpoints', () => {
    let tmp: string;
    let repo: string;

    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
    const commit = (cwd: string, message: string) => git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-am', message);
    const write = (file: string, text: string | Buffer) => fs.writeFile(path.join(repo, file), text);
    const read = (file: string) => fs.readFile(path.join(repo, file), 'utf8');
    const exists = (file: string) =>
        fs.access(path.join(repo, file)).then(
            () => true,
            () => false
        );
    const save = (turn: string, now?: number) => createCheckpoint(repo, { session: 'session-1', kind: 'prompt', prompt: turn, agent: 'Claude', now });

    beforeEach(async () => {
        tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-checkpoints-')));
        repo = path.join(tmp, 'repo');
        await fs.mkdir(repo);
        git(repo, 'init', '-q', '-b', 'main');
        await write('a.txt', 'one\n');
        await write('.gitignore', 'ignored/\n');
        git(repo, 'add', '.');
        commit(repo, 'init');
    });

    afterEach(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    it('saves tracked changes and new files without a change to the index, the files, or the stash list', async () => {
        await write('a.txt', 'two\n');
        await write('new.txt', 'new\n');
        await write('staged.txt', 'staged\n');
        git(repo, 'add', 'staged.txt');
        const statusBefore = git(repo, 'status', '--porcelain');

        const saved = await save('Fix the bug');

        expect(saved?.ref).toBe('refs/shipwarden/checkpoints/session-1/000001');
        expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
        expect(git(repo, 'stash', 'list')).toBe('');
        expect(git(repo, 'show', `${saved!.commit}:a.txt`)).toBe('two\n');
        expect(git(repo, 'show', `${saved!.commit}:new.txt`)).toBe('new\n');
        expect(git(repo, 'show', `${saved!.commit}:staged.txt`)).toBe('staged\n');
        expect(git(repo, 'rev-parse', `${saved!.commit}^`).trim()).toBe(git(repo, 'rev-parse', 'HEAD').trim());
    });

    it('skips a checkpoint when nothing changed since the last one', async () => {
        expect(await save('First')).toBeDefined();
        expect(await save('Second')).toBeUndefined();
        await write('a.txt', 'changed\n');
        expect((await save('Third'))?.ref).toBe('refs/shipwarden/checkpoints/session-1/000002');
    });

    it('does not save the files that .gitignore ignores', async () => {
        await fs.mkdir(path.join(repo, 'ignored'));
        await write('ignored/cache.bin', 'cache');
        const saved = await save('Turn');
        expect(git(repo, 'ls-tree', '-r', '--name-only', saved!.commit)).not.toContain('ignored/');
    });

    it('lists the turns with their prompts and changed files', async () => {
        await save('First prompt', 1000);
        await write('a.txt', 'two\n');
        await write('b.txt', 'b\n');
        await save('Second prompt', 2000);
        await fs.rm(path.join(repo, 'b.txt'));

        const list = await listCheckpoints(repo);

        expect(list.map(item => [item.turn, item.prompt, item.agent])).toEqual([
            [2, 'Second prompt', 'Claude'],
            [1, 'First prompt', 'Claude']
        ]);
        expect(list[1].files).toEqual([
            { path: 'a.txt', status: 'modified' },
            { path: 'b.txt', status: 'added' }
        ]);
        expect(list[0].files).toEqual([{ path: 'b.txt', status: 'deleted' }]);
    });

    it('rewinds tracked changes, deleted files, new files, and binary files', async () => {
        const binary = Buffer.from([0, 1, 2, 3, 255, 0, 10]);
        await write('image.bin', binary);
        await write('kept-new.txt', 'from before the turn\n');
        const saved = await save('Turn');

        // The agent changes a file, deletes a file, adds files in a new folder, and changes the binary file.
        await write('a.txt', 'agent\n');
        await fs.rm(path.join(repo, 'kept-new.txt'));
        await fs.mkdir(path.join(repo, 'src', 'deep'), { recursive: true });
        await write('src/deep/new.ts', 'export {};\n');
        await write('image.bin', Buffer.from([9, 9, 0, 9]));
        await fs.mkdir(path.join(repo, 'ignored'));
        await write('ignored/keep.txt', 'ignored');

        const preview = await previewRewind(repo, saved!.ref);
        expect(preview.files).toEqual([
            { path: 'a.txt', action: 'revert', additions: 1, deletions: 1, binary: false },
            { path: 'image.bin', action: 'revert', binary: true },
            { path: 'kept-new.txt', action: 'restore', additions: 1, deletions: 0, binary: false },
            { path: 'src/deep/new.ts', action: 'remove', additions: 0, deletions: 1, binary: false }
        ]);
        expect(preview.patch).toContain('-agent');
        expect(preview.commits).toEqual([]);
        expect(preview.headDiverged).toBe(false);

        const result = await rewindToCheckpoint(repo, saved!.ref, { reset: false });

        expect(result).toMatchObject({ restored: 3, removed: 1, reset: false });
        expect(await read('a.txt')).toBe('one\n');
        expect(await read('kept-new.txt')).toBe('from before the turn\n');
        expect(await fs.readFile(path.join(repo, 'image.bin'))).toEqual(binary);
        expect(await exists('src/deep/new.ts')).toBe(false);
        expect(await exists('src')).toBe(false);
        expect(await read('ignored/keep.txt')).toBe('ignored');
        // The rewind saved the state before it, so the user can go back.
        expect(result.backup).toBe('refs/shipwarden/checkpoints/session-1/000002');
        await rewindToCheckpoint(repo, result.backup!, { reset: false });
        expect(await read('a.txt')).toBe('agent\n');
        expect(await read('src/deep/new.ts')).toBe('export {};\n');
    });

    it('keeps the commits after the checkpoint, or resets them when the user agrees', async () => {
        const head = git(repo, 'rev-parse', 'HEAD').trim();
        const saved = await save('Turn');
        await write('a.txt', 'agent commit\n');
        commit(repo, 'Agent work');
        await write('a.txt', 'agent uncommitted\n');

        const preview = await previewRewind(repo, saved!.ref);
        expect(preview.commits.map(item => item.subject)).toEqual(['Agent work']);

        await rewindToCheckpoint(repo, saved!.ref, { reset: false });
        expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('Agent work');
        expect(await read('a.txt')).toBe('one\n');

        const result = await rewindToCheckpoint(repo, saved!.ref, { reset: true });
        expect(result.reset).toBe(true);
        expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(head);
        expect(git(repo, 'status', '--porcelain')).toBe('');
    });

    it('refuses a reset when the branch did not move forward from the checkpoint', async () => {
        const saved = await save('Turn');
        await write('a.txt', 'two\n');
        await expect(rewindToCheckpoint(repo, saved!.ref, { reset: true })).rejects.toThrow('did not move forward');
        expect(await read('a.txt')).toBe('two\n');
    });

    it('removes the checkpoints of a removed worktree, of old turns, and of missing folders', async () => {
        const worktree = path.join(tmp, 'feature');
        git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
        await createCheckpoint(worktree, { session: 'session-2', kind: 'idle' });
        await save('Old', Date.now() - CHECKPOINT_MAX_AGE_MS - 1000);
        await write('a.txt', 'two\n');
        await save('New');
        const refs = () => git(repo, 'for-each-ref', '--format=%(refname)', 'refs/shipwarden/').trim().split('\n').filter(Boolean);
        expect(refs()).toHaveLength(3);

        expect(await removeWorktreeCheckpoints(repo, worktree)).toBe(1);
        expect(await pruneCheckpoints(repo)).toBe(1);
        expect(refs()).toEqual(['refs/shipwarden/checkpoints/session-1/000002']);

        expect(await pruneCheckpoints(repo, Date.now() + CHECKPOINT_MAX_AGE_MS + 1000)).toBe(1);
        expect(refs()).toEqual([]);
    });
});
