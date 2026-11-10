import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileService, parseGitGrep, resolveInside } from './file-service';

describe('FileService', () => {
    let root: string;
    const service = new FileService();

    beforeEach(async () => {
        root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-files-')));
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
        await fs.mkdir(path.join(root, 'src'));
        await fs.mkdir(path.join(root, 'build'));
        await fs.mkdir(path.join(root, '.github'));
        await fs.writeFile(path.join(root, '.gitignore'), 'build/\n*.log\n');
        await fs.writeFile(path.join(root, 'README.md'), '# Demo\nHello World\n');
        await fs.writeFile(path.join(root, 'package.json'), '{}\n');
        await fs.writeFile(path.join(root, 'debug.log'), 'hello log\n');
        await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const hello = "world";\n');
        await fs.writeFile(path.join(root, 'build', 'out.js'), 'hello build\n');
        await fs.writeFile(path.join(root, 'image.bin'), Buffer.from([1, 0, 2, 0]));
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    it('lists a folder with folders first, hides .git and marks ignored entries', async () => {
        const entries = await service.listDirectory(root, '');
        expect(entries.map(entry => [entry.name, entry.isDirectory, entry.ignored])).toEqual([
            ['.github', true, false],
            ['build', true, true],
            ['src', true, false],
            ['.gitignore', false, false],
            ['debug.log', false, true],
            ['image.bin', false, false],
            ['package.json', false, false],
            ['README.md', false, false]
        ]);
    });

    it('lists a subfolder with relative paths', async () => {
        const entries = await service.listDirectory(root, 'src');
        expect(entries).toEqual([{ name: 'index.ts', path: 'src/index.ts', isDirectory: false, ignored: false }]);
    });

    it('lists the files that git does not ignore', async () => {
        const files = await service.listFiles(root);
        expect(files.sort()).toEqual(['.gitignore', 'README.md', 'image.bin', 'package.json', 'src/index.ts']);
    });

    it('searches file contents, ignores case and skips ignored files', async () => {
        const result = await service.searchContents(root, 'hello');
        expect(result.truncated).toBe(false);
        expect(result.matches).toEqual([
            { path: 'README.md', line: 2, text: 'Hello World' },
            { path: 'src/index.ts', line: 1, text: 'export const hello = "world";' }
        ]);
    });

    it('matches case when caseSensitive is true', async () => {
        const result = await service.searchContents(root, 'Hello', true);
        expect(result.matches).toEqual([{ path: 'README.md', line: 2, text: 'Hello World' }]);
    });

    it('returns no matches for an empty query or a query with no matches', async () => {
        expect((await service.searchContents(root, '  ')).matches).toEqual([]);
        expect((await service.searchContents(root, 'no-such-text')).matches).toEqual([]);
    });

    it('reads and writes text files', async () => {
        await service.writeFile(root, 'src/index.ts', 'changed\n');
        expect(await service.readFile(root, 'src/index.ts')).toBe('changed\n');
    });

    it('does not open binary files', async () => {
        await expect(service.readFile(root, 'image.bin')).rejects.toThrow('binary');
    });

    it('does not read or write outside the worktree', async () => {
        await expect(service.readFile(root, '../outside.txt')).rejects.toThrow('outside the worktree');
        await expect(service.writeFile(root, '/etc/hosts', 'x')).rejects.toThrow('outside the worktree');
    });
});

describe('resolveInside', () => {
    it('accepts paths in the root and rejects paths outside it', () => {
        expect(resolveInside('/repo', 'src/a.ts')).toBe('/repo/src/a.ts');
        expect(resolveInside('/repo', '')).toBe('/repo');
        expect(() => resolveInside('/repo', '../x')).toThrow();
        expect(() => resolveInside('/repo', 'src/../../x')).toThrow();
    });
});

describe('parseGitGrep', () => {
    it('parses the null-separated output and stops at the limit', () => {
        const output = 'a.ts\u00001\u0000one\nb.ts\u000012\u0000two: with colon\nc.ts\u00003\u0000three\n';
        expect(parseGitGrep(output, 2)).toEqual({
            matches: [
                { path: 'a.ts', line: 1, text: 'one' },
                { path: 'b.ts', line: 12, text: 'two: with colon' }
            ],
            truncated: true
        });
    });
});
