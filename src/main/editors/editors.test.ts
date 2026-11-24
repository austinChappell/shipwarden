import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectEditors, editorFolders, openInEditor } from './editors';

let dir: string;

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'editors-'));
});

afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe('editorFolders', () => {
    it('searches /Applications, Setapp, ~/Applications, and the JetBrains Toolbox folder', () => {
        expect(editorFolders('/Users/me')).toEqual([
            '/Applications',
            '/Applications/Setapp',
            '/Users/me/Applications',
            '/Users/me/Applications/JetBrains Toolbox'
        ]);
    });
});

describe('detectEditors', () => {
    it('finds the editor apps in the folders and ignores a missing folder', async () => {
        const apps = path.join(dir, 'Applications');
        const user = path.join(dir, 'user');
        await fs.mkdir(path.join(apps, 'Zed.app'), { recursive: true });
        await fs.mkdir(path.join(apps, 'Notes.app'));
        await fs.mkdir(path.join(user, 'GoLand.app'), { recursive: true });
        const editors = await detectEditors([apps, path.join(dir, 'missing'), user]);
        expect(editors.map(editor => editor.appPath)).toEqual([path.join(apps, 'Zed.app'), path.join(user, 'GoLand.app')]);
    });
});

describe('openInEditor', () => {
    /** Makes a fake Zed app with a CLI that writes its arguments to a file. */
    async function fakeZed(script: string) {
        const appPath = path.join(dir, 'Zed.app');
        const cli = path.join(appPath, 'Contents/MacOS/cli');
        await fs.mkdir(path.dirname(cli), { recursive: true });
        await fs.writeFile(cli, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
        return { appPath, name: 'Zed', kind: 'zed' as const, cli: 'Contents/MacOS/cli' };
    }

    it('runs the CLI of the editor with the folder and the file at its line', async () => {
        const out = path.join(dir, 'args.txt');
        const editor = await fakeZed(`printf '%s\\n' "$@" > '${out}'`);
        await openInEditor(editor, { folder: dir, file: path.join(dir, 'a.ts'), line: 4 });
        expect(await fs.readFile(out, 'utf8')).toBe(`${dir}\n${path.join(dir, 'a.ts')}:4\n`);
    });

    it('rejects with the error output of a failed command', async () => {
        const editor = await fakeZed(`echo 'no such window' >&2; exit 3`);
        await expect(openInEditor(editor, { folder: dir })).rejects.toThrow('no such window');
    });

    it('names the signal when a signal stops the command', async () => {
        const editor = await fakeZed('kill -9 $$');
        await expect(openInEditor(editor, { folder: dir })).rejects.toThrow('"cli" stopped with the signal SIGKILL.');
    });

    it('removes the Electron variables from the environment', async () => {
        const out = path.join(dir, 'env.txt');
        const editor = await fakeZed(`echo "[$ELECTRON_RUN_AS_NODE][$VSCODE_IPC_HOOK_CLI]" > '${out}'`);
        process.env.ELECTRON_RUN_AS_NODE = '1';
        process.env.VSCODE_IPC_HOOK_CLI = '/tmp/hook';
        try {
            await openInEditor(editor, { folder: dir });
        } finally {
            delete process.env.ELECTRON_RUN_AS_NODE;
            delete process.env.VSCODE_IPC_HOOK_CLI;
        }
        expect(await fs.readFile(out, 'utf8')).toBe('[][]\n');
    });
});
