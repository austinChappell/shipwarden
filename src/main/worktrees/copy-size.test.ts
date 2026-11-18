import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { largeCopyEntries } from './copy-size';

describe('largeCopyEntries', () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-size-'));
        await fs.writeFile(path.join(root, '.env'), 'A=1');
        await fs.mkdir(path.join(root, 'backups'));
        await fs.writeFile(path.join(root, 'backups', 'db.dump'), Buffer.alloc(2000));
        await fs.mkdir(path.join(root, 'data', 'deep'), { recursive: true });
        await fs.writeFile(path.join(root, 'data', 'a.bin'), Buffer.alloc(800));
        await fs.writeFile(path.join(root, 'data', 'deep', 'b.bin'), Buffer.alloc(800));
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    it('reports the files and folders of the limit or more, the largest first', async () => {
        const large = await largeCopyEntries(root, ['.env', 'backups/db.dump', 'data/'], 1000);
        expect(large).toEqual([
            { path: 'backups/db.dump', bytes: 2000 },
            { path: 'data/', bytes: 1600, atLeast: true }
        ]);
    });

    it('does not report small or missing entries', async () => {
        expect(await largeCopyEntries(root, ['.env', 'missing.txt', 'data/'], 10_000)).toEqual([]);
    });
});
