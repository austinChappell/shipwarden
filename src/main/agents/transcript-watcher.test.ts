import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TranscriptWatcher } from './transcript-watcher';

/** Waits until the check is true, or fails after the timeout. */
async function until(check: () => boolean, timeout = 3000): Promise<void> {
    const end = Date.now() + timeout;
    while (!check()) {
        if (Date.now() > end) throw new Error('Timed out');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

describe('TranscriptWatcher', () => {
    let root: string;
    let watcher: TranscriptWatcher;
    let changes: string[];

    beforeEach(async () => {
        root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'transcript-watch-')));
        changes = [];
        watcher = new TranscriptWatcher(file => changes.push(file), [root]);
    });

    afterEach(async () => {
        watcher.dispose();
        await rm(root, { recursive: true, force: true });
    });

    it('refuses a file outside the Claude Code data folders', () => {
        expect(() => watcher.start(path.join(os.tmpdir(), 'x.jsonl'))).toThrow('Claude Code data folder');
    });

    it('reports a change of the file, also when the file is made after the start', async () => {
        const file = path.join(root, 'session.jsonl');
        watcher.start(file);
        await writeFile(file, '{"a":1}\n');
        await until(() => changes.length > 0);
        expect(changes.every(item => item === file)).toBe(true);
        changes.length = 0;
        await appendFile(file, '{"b":2}\n');
        await until(() => changes.length > 0);
    });

    it('reports a change of the file, also when the folder of the file is made after the start', async () => {
        const folder = path.join(root, 'new-project');
        const file = path.join(folder, 'session.jsonl');
        watcher.start(file);
        await mkdir(folder);
        await writeFile(file, '{"a":1}\n');
        await until(() => changes.length > 0);
        expect(changes.every(item => item === file)).toBe(true);
        changes.length = 0;
        await appendFile(file, '{"b":2}\n');
        await until(() => changes.length > 0);
    });

    it('refuses a file when its folder and the parent folder are missing', () => {
        expect(() => watcher.start(path.join(root, 'a', 'b', 'session.jsonl'))).toThrow();
        // A failed start keeps no watch, so a new start tries again.
        expect(() => watcher.start(path.join(root, 'a', 'b', 'session.jsonl'))).toThrow();
    });

    it('does not report other files in the folder', async () => {
        watcher.start(path.join(root, 'session.jsonl'));
        await writeFile(path.join(root, 'other.jsonl'), '{}\n');
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(changes).toEqual([]);
    });

    it('stops after the last user', async () => {
        const file = path.join(root, 'session.jsonl');
        watcher.start(file);
        watcher.start(file);
        watcher.stop(file);
        await writeFile(file, '{}\n');
        await until(() => changes.length > 0);
        watcher.stop(file);
        changes.length = 0;
        await appendFile(file, '{}\n');
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(changes).toEqual([]);
    });
});
