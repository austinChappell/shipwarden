import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KeybindingsState } from '@shared/keybindings';
import { DEFAULT_KEYMAP } from '@shared/shortcuts';
import { KeybindingStore, KeybindingsFileError } from './keybinding-store';

describe('KeybindingStore', () => {
    let root: string;
    let file: string;
    let store: KeybindingStore;

    beforeEach(async () => {
        root = await mkdtemp(path.join(os.tmpdir(), 'keybindings-'));
        file = path.join(root, 'shipwarden', 'keybindings.json');
        store = new KeybindingStore(file);
    });

    afterEach(async () => {
        store.close();
        await rm(root, { recursive: true, force: true });
    });

    it('has the default keys without a file', async () => {
        expect(await store.load()).toEqual({ file, overrides: {}, problems: [] });
        expect(store.keymap().keys.right).toEqual(DEFAULT_KEYMAP.keys.right);
    });

    it('reads a bad file without an error', async () => {
        await store.update([]);
        await writeFile(file, '{ "newTab": ');
        const state = await store.load();
        expect(state.overrides).toEqual({});
        expect(state.problems[0]).toMatch(/not valid JSON/);
    });

    it('writes the changes and keeps the entries that it does not know', async () => {
        await store.update([]);
        await writeFile(file, JSON.stringify({ someday: 'Cmd+J', newTab: 'Cmd+Shift+T' }));
        const state = await store.update([{ command: 'commandPalette', keys: ['CmdOrCtrl+Shift+K'] }]);
        expect(state.overrides).toEqual({ newTab: ['CmdOrCtrl+Shift+T'], commandPalette: ['CmdOrCtrl+Shift+K'] });
        expect(state.problems).toHaveLength(1);
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ someday: 'Cmd+J', newTab: 'Cmd+Shift+T', commandPalette: 'CmdOrCtrl+Shift+K' });
        expect(store.keymap().keys.commandPalette.map(chord => chord.key)).toEqual(['K']);
    });

    it('does not write over a file that is not valid JSON, but Reset all replaces it', async () => {
        await store.update([]);
        await writeFile(file, 'not json');
        await expect(store.update([{ command: 'newTab', reset: true }])).rejects.toBeInstanceOf(KeybindingsFileError);
        expect(await readFile(file, 'utf8')).toBe('not json');
        expect(await store.resetAll()).toEqual({ file, overrides: {}, problems: [] });
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({});
    });

    it('tells the listeners about a change of the file from another app', async () => {
        await store.update([]);
        const states: KeybindingsState[] = [];
        store.subscribe(state => states.push(state));
        await store.watch();
        await writeFile(file, JSON.stringify({ newTab: null }));
        for (let attempt = 0; attempt < 50 && states.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
        expect(states.at(-1)?.overrides).toEqual({ newTab: [] });
    });
});
