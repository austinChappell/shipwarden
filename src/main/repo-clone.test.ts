import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, promises as fs, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RepoRef } from '@shared/github';
import { cloneRepo } from './repo-clone';

describe('cloneRepo', () => {
    let tmp: string;
    let origin: string;
    let parent: string;
    const repo: RepoRef = { owner: 'acme', name: 'api' };
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    /** The folder of each clone has the "origin" remote of acme/api. Other folders have no GitHub remote. */
    const options = (cloneUrl = () => origin) => ({
        cloneUrl,
        repoFor: async (root: string) => (existsSync(path.join(root, '.git')) && root.endsWith('api') ? repo : null)
    });

    beforeEach(async () => {
        tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-clone-test-')));
        const seed = path.join(tmp, 'seed');
        await fs.mkdir(seed);
        git(seed, 'init', '-q', '-b', 'main');
        writeFileSync(path.join(seed, 'main.ts'), 'export const a = 1;');
        git(seed, 'add', 'main.ts');
        git(seed, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'first');
        origin = path.join(tmp, 'origin.git');
        git(tmp, 'clone', '-q', '--bare', seed, origin);
        parent = path.join(tmp, 'code');
        await fs.mkdir(parent);
    });

    afterEach(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    it('clones the repository into a folder with the repository name', async () => {
        const root = await cloneRepo(parent, repo, options());
        expect(root).toBe(path.join(parent, 'api'));
        expect(existsSync(path.join(root, 'main.ts'))).toBe(true);
    });

    it('uses a folder that is a clone of the same repository', async () => {
        const first = await cloneRepo(parent, repo, options());
        const second = await cloneRepo(
            parent,
            repo,
            options(() => path.join(tmp, 'missing.git'))
        );
        expect(second).toBe(first);
    });

    it('does not use a folder that is not a clone of the repository', async () => {
        await fs.mkdir(path.join(parent, 'api'));
        await expect(cloneRepo(parent, repo, options())).rejects.toThrow('is not a clone of acme/api');
    });

    it('removes the folder when the clone fails', async () => {
        await expect(
            cloneRepo(
                parent,
                repo,
                options(() => path.join(tmp, 'missing.git'))
            )
        ).rejects.toThrow('git clone failed');
        expect(existsSync(path.join(parent, 'api'))).toBe(false);
    });

    it('rejects a repository name that is not a folder name', async () => {
        await expect(cloneRepo(parent, { owner: 'acme', name: '..' }, options())).rejects.toThrow('not a valid repository name');
    });
});
