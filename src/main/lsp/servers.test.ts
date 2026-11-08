import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findLegacyTsserver, installCommand, SERVER_DEFINITIONS, type ServerDefinition } from './servers';

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

describe('installCommand', () => {
    const definition = (install: ServerDefinition['install']): ServerDefinition => ({
        id: 'test',
        name: 'test',
        languages: [],
        resolve: async () => undefined,
        install
    });
    let oldPath: string | undefined;

    beforeEach(async () => {
        oldPath = process.env.PATH;
        const bin = path.join(temp, 'bin');
        await fs.mkdir(bin);
        await fs.writeFile(path.join(bin, 'second-tool'), '', { mode: 0o755 });
        process.env.PATH = bin;
    });

    afterEach(() => {
        process.env.PATH = oldPath;
    });

    it('returns the command of the first tool that is in the PATH', async () => {
        const result = await installCommand(definition([
            { tool: 'first-tool', command: 'first-tool install' },
            { tool: 'second-tool', command: 'second-tool install' }
        ]));
        expect(result).toBe('second-tool install');
    });

    it('returns undefined when no tool is in the PATH', async () => {
        expect(await installCommand(definition([{ tool: 'first-tool', command: 'first-tool install' }]))).toBeUndefined();
    });

    it('gives an install command to each server that ShipWarden does not include', () => {
        for (const server of SERVER_DEFINITIONS.filter(item => item.id !== 'typescript')) {
            expect(server.install.length, server.id).toBeGreaterThan(0);
        }
    });
});
