import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findLegacyTsserver, managedPaths, resolveManaged, SERVER_DEFINITIONS, setManagedFolder } from './servers';

let temp: string;

async function addTypeScript(folder: string, version: string, withTsserver = true): Promise<string> {
    const lib = path.join(folder, 'node_modules', 'typescript', 'lib');
    await fs.mkdir(lib, { recursive: true });
    await fs.writeFile(path.join(folder, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ version }));
    const tsserver = path.join(lib, 'tsserver.js');
    if (withTsserver) {
        await fs.writeFile(tsserver, '');
    }
    return tsserver;
}

beforeEach(async () => {
    temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-servers-')));
});

afterEach(async () => {
    await fs.rm(temp, { recursive: true, force: true });
});

describe('findLegacyTsserver', () => {
    it('returns tsserver.js of a TypeScript that is older than version 7', async () => {
        const tsserver = await addTypeScript(temp, '4.8.4');
        expect(await findLegacyTsserver(temp)).toBe(tsserver);
    });

    it('returns undefined for TypeScript 7', async () => {
        await addTypeScript(temp, '7.0.2');
        expect(await findLegacyTsserver(temp)).toBeUndefined();
    });

    it('returns undefined when the worktree has no TypeScript', async () => {
        expect(await findLegacyTsserver(temp)).toBeUndefined();
    });

    it('returns undefined when tsserver.js is missing', async () => {
        await addTypeScript(temp, '5.4.0', false);
        expect(await findLegacyTsserver(temp)).toBeUndefined();
    });

    it('finds the TypeScript of a parent folder', async () => {
        const tsserver = await addTypeScript(temp, '5.9.3');
        const packageFolder = path.join(temp, 'packages', 'api');
        await fs.mkdir(packageFolder, { recursive: true });
        expect(await findLegacyTsserver(packageFolder)).toBe(tsserver);
    });

    it('uses the nearest TypeScript', async () => {
        await addTypeScript(temp, '5.9.3');
        const packageFolder = path.join(temp, 'packages', 'api');
        const tsserver = await addTypeScript(packageFolder, '4.8.4');
        expect(await findLegacyTsserver(packageFolder)).toBe(tsserver);
    });
});

describe('managed servers', () => {
    afterEach(() => {
        setManagedFolder(undefined);
    });

    it('puts each server in its own folder', () => {
        expect(managedPaths('/data/language-servers')).toEqual({
            rustAnalyzer: '/data/language-servers/rust-analyzer/rust-analyzer',
            basedpyrightPackage: '/data/language-servers/basedpyright/package',
            basedpyright: '/data/language-servers/basedpyright/package/langserver.index.js',
            goBin: '/data/language-servers/gopls/bin',
            gopls: '/data/language-servers/gopls/bin/gopls'
        });
    });

    it('returns undefined when the managed folder has no server', async () => {
        expect(await resolveManaged('rust-analyzer', temp)).toBeUndefined();
        expect(await resolveManaged('python', temp)).toBeUndefined();
        expect(await resolveManaged('gopls', temp)).toBeUndefined();
        expect(await resolveManaged('rust-analyzer', undefined)).toBeUndefined();
    });

    it('finds the binaries and the basedpyright script in the managed folder', async () => {
        const paths = managedPaths(temp);
        await fs.mkdir(path.dirname(paths.rustAnalyzer), { recursive: true });
        await fs.writeFile(paths.rustAnalyzer, '', { mode: 0o755 });
        await fs.mkdir(paths.goBin, { recursive: true });
        await fs.writeFile(paths.gopls, '', { mode: 0o755 });
        await fs.mkdir(paths.basedpyrightPackage, { recursive: true });
        await fs.writeFile(paths.basedpyright, '');

        expect(await resolveManaged('rust-analyzer', temp)).toEqual({ command: paths.rustAnalyzer, args: [] });
        expect(await resolveManaged('gopls', temp)).toEqual({ command: paths.gopls, args: [] });
        expect(await resolveManaged('python', temp)).toEqual({
            command: process.execPath,
            args: [paths.basedpyright, '--stdio'],
            env: { ELECTRON_RUN_AS_NODE: '1' }
        });
    });

    it('does not use a binary that is not executable', async () => {
        const paths = managedPaths(temp);
        await fs.mkdir(path.dirname(paths.rustAnalyzer), { recursive: true });
        await fs.writeFile(paths.rustAnalyzer, '', { mode: 0o644 });
        expect(await resolveManaged('rust-analyzer', temp)).toBeUndefined();
    });

    it('uses the managed folder before the PATH', async () => {
        const oldPath = process.env.PATH;
        const bin = path.join(temp, 'bin');
        await fs.mkdir(bin);
        await fs.writeFile(path.join(bin, 'gopls'), '', { mode: 0o755 });
        process.env.PATH = bin;
        try {
            const gopls = SERVER_DEFINITIONS.find(server => server.id === 'gopls')!;
            expect((await gopls.resolve(temp))?.command).toBe(path.join(bin, 'gopls'));

            const managed = path.join(temp, 'managed');
            const paths = managedPaths(managed);
            await fs.mkdir(paths.goBin, { recursive: true });
            await fs.writeFile(paths.gopls, '', { mode: 0o755 });
            setManagedFolder(managed);
            expect((await gopls.resolve(temp))?.command).toBe(paths.gopls);
        } finally {
            process.env.PATH = oldPath;
        }
    });

    it('lets ShipWarden install each server that it does not include, or tells the user how to install it', () => {
        for (const server of SERVER_DEFINITIONS) {
            expect(server.installable, server.id).toBe(server.id !== 'typescript' && server.id !== 'ruby');
        }
        expect(SERVER_DEFINITIONS.find(server => server.id === 'ruby')?.installHint).toBeTruthy();
    });
});

describe('Ruby', () => {
    let oldPath: string | undefined;
    let bin: string;
    const ruby = () => SERVER_DEFINITIONS.find(server => server.id === 'ruby')!;

    beforeEach(async () => {
        oldPath = process.env.PATH;
        bin = path.join(temp, 'path-bin');
        await fs.mkdir(bin);
        process.env.PATH = bin;
    });

    afterEach(() => {
        process.env.PATH = oldPath;
    });

    async function addCommand(name: string): Promise<string> {
        const file = path.join(bin, name);
        await fs.writeFile(file, '', { mode: 0o755 });
        return file;
    }

    async function addSorbetConfig(): Promise<void> {
        await fs.mkdir(path.join(temp, 'sorbet'));
        await fs.writeFile(path.join(temp, 'sorbet', 'config'), '.\n');
    }

    it('uses ruby-lsp when the worktree has no Sorbet config', async () => {
        const rubyLsp = await addCommand('ruby-lsp');
        await addCommand('srb');
        expect(await ruby().resolve(temp)).toEqual({ command: rubyLsp, args: [] });
    });

    it('uses "bundle exec srb" in a Sorbet worktree with a Gemfile', async () => {
        await addSorbetConfig();
        await fs.writeFile(path.join(temp, 'Gemfile'), '');
        const bundle = await addCommand('bundle');
        await addCommand('ruby-lsp');
        expect(await ruby().resolve(temp)).toEqual({ command: bundle, args: ['exec', 'srb', 'typecheck', '--lsp', '--disable-watchman'] });
    });

    it('uses the bin/srb binstub first', async () => {
        await addSorbetConfig();
        await fs.writeFile(path.join(temp, 'Gemfile'), '');
        await addCommand('bundle');
        await fs.mkdir(path.join(temp, 'bin'));
        const binstub = path.join(temp, 'bin', 'srb');
        await fs.writeFile(binstub, '', { mode: 0o755 });
        expect((await ruby().resolve(temp))?.command).toBe(binstub);
    });

    it('keeps Watchman when it is in the PATH', async () => {
        await addSorbetConfig();
        const srb = await addCommand('srb');
        await addCommand('watchman');
        expect(await ruby().resolve(temp)).toEqual({ command: srb, args: ['typecheck', '--lsp'] });
    });

    it('returns undefined when no Ruby server is available', async () => {
        expect(await ruby().resolve(temp)).toBeUndefined();
        await addSorbetConfig();
        expect(await ruby().resolve(temp)).toBeUndefined();
    });
});
