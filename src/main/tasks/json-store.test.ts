import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonStore } from './json-store';

describe('JsonStore', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-store-'));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('writes each change with a rename and leaves no temporary file', async () => {
        const file = path.join(dir, 'sub', 'data.json');
        const store = new JsonStore<Record<string, number>>(file, () => ({}));
        await Promise.all([1, 2, 3].map(value => store.update(all => ({ ...all, [`k${value}`]: value }))));
        expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ k1: 1, k2: 2, k3: 3 });
        expect(await fs.readdir(path.dirname(file))).toEqual(['data.json']);
        expect(await new JsonStore<Record<string, number>>(file, () => ({})).get()).toEqual({ k1: 1, k2: 2, k3: 3 });
    });
});
