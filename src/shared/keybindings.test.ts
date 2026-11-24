import { describe, expect, it } from 'vitest';
import { parseChord, type KeyChord } from './key-chords';
import {
    applyKeybindingChanges,
    assignKey,
    findConflicts,
    hasDefaultKeys,
    invalidKeyReason,
    keymapOf,
    mergeKeybindings,
    parseKeybindingsFile,
    reservedKey
} from './keybindings';
import {
    appKeyAction,
    DEFAULT_KEYMAP,
    isClearKey,
    isCommentKey,
    KEY_COMMANDS,
    keyCommand,
    keyLabel,
    pullRequestKeyAction,
    remapKeyText,
    shortcutAction,
    shortcutRows,
    type KeyCommand
} from './shortcuts';

const chord = (text: string): KeyChord => {
    const parsed = parseChord(text);
    if (!parsed) throw new Error(`"${text}" is not a key.`);
    return parsed;
};
const command = (id: string): KeyCommand => keyCommand(id) as KeyCommand;
const press = (text: string) => {
    const parsed = chord(text);
    const code = /^[A-Z]$/.test(parsed.key) ? `Key${parsed.key}` : /^\d$/.test(parsed.key) ? `Digit${parsed.key}` : parsed.key;
    return { type: 'keyDown', meta: parsed.meta, control: parsed.control, alt: parsed.alt, shift: parsed.shift, key: parsed.key.toLowerCase(), code };
};

describe('parseKeybindingsFile', () => {
    it('reads keys, lists of keys, and null', () => {
        const parsed = parseKeybindingsFile(
            JSON.stringify({ commandPalette: 'CmdOrCtrl+Shift+K', previousTab: ['⇧⌘[', 'Ctrl+Shift+Tab', 'Cmd+Shift+['], newTab: null, nextTab: [] })
        );
        expect(parsed.problems).toEqual([]);
        expect(parsed.overrides).toEqual({
            commandPalette: ['CmdOrCtrl+Shift+K'],
            previousTab: ['CmdOrCtrl+Shift+[', 'Ctrl+Shift+Tab'],
            newTab: [],
            nextTab: []
        });
    });

    it('reads an empty file as no changes', () => {
        expect(parseKeybindingsFile('')).toEqual({ overrides: {}, problems: [] });
        expect(parseKeybindingsFile('  \n')).toEqual({ overrides: {}, problems: [] });
    });

    it('never throws on a bad file', () => {
        expect(parseKeybindingsFile('{ "newTab": ').problems[0]).toMatch(/not valid JSON/);
        expect(parseKeybindingsFile('["newTab"]').problems[0]).toMatch(/one JSON object/);
        expect(parseKeybindingsFile('null').overrides).toEqual({});
        expect(parseKeybindingsFile('42').overrides).toEqual({});
    });

    it('ignores each entry that is not valid and keeps the other entries', () => {
        const parsed = parseKeybindingsFile(
            JSON.stringify({
                commandPalette: 'Cmd+Shift+K',
                noSuchCommand: 'Cmd+J',
                newTab: 'Cmd+Hyper+T',
                close: 'Shift+W',
                right: 'Cmd+Q',
                down: 42,
                back: ['Cmd+[', 7]
            })
        );
        expect(parsed.overrides).toEqual({ commandPalette: ['CmdOrCtrl+Shift+K'] });
        expect(parsed.problems).toHaveLength(6);
        expect(parsed.problems.join('\n')).toMatch(/"noSuchCommand" is not a command/);
        expect(parsed.problems.join('\n')).toMatch(/"newTab": "Cmd\+Hyper\+T" is not a key/);
        expect(parsed.problems.join('\n')).toMatch(/"close": ⇧W has no ⌘ or ⌃/);
        expect(parsed.problems.join('\n')).toMatch(/"right": ⌘Q is the key of "Quit ShipWarden"/);
    });
});

describe('mergeKeybindings and keymapOf', () => {
    it('keeps the defaults of the commands that the file does not change', () => {
        const merged = mergeKeybindings({ commandPalette: ['CmdOrCtrl+Shift+K'], newTab: [] });
        expect(merged.commandPalette).toEqual([chord('⇧⌘K')]);
        expect(merged.newTab).toEqual([]);
        expect(merged.right).toEqual([chord('⌘D')]);
        expect(merged.previousTab).toEqual([chord('⇧⌘['), chord('⌃⇧Tab')]);
    });

    it('gives the same keymap for the same overrides, and the default lists for unchanged commands', () => {
        const overrides = { commandPalette: ['CmdOrCtrl+Shift+K'] };
        const keymap = keymapOf(overrides);
        expect(keymapOf(overrides)).toBe(keymap);
        expect(keymap.keys.right).toBe(DEFAULT_KEYMAP.keys.right);
        expect(hasDefaultKeys(keymap, command('right'))).toBe(true);
        expect(hasDefaultKeys(keymap, command('commandPalette'))).toBe(false);
        expect(keyLabel(keymap, 'commandPalette')).toBe('⇧⌘K');
    });

    it('changes the key handlers', () => {
        const keymap = keymapOf({ commandPalette: ['CmdOrCtrl+Shift+K'], newTab: [], settings: ['CmdOrCtrl+Alt+,'], clearTerminal: ['Ctrl+Cmd+K'] });
        expect(shortcutAction(press('⇧⌘K'), keymap)).toBe('commandPalette');
        expect(shortcutAction(press('⇧⌘P'), keymap)).toBeUndefined();
        expect(shortcutAction(press('⌘T'), keymap)).toBeUndefined();
        expect(shortcutAction(press('⌘D'), keymap)).toBe('right');
        expect(appKeyAction({ ...press('⌥⌘,'), key: ',', code: 'Comma' }, keymap)).toBe('settings');
        expect(appKeyAction({ ...press('⌘,'), key: ',', code: 'Comma' }, keymap)).toBeUndefined();
        // ⌘Q and ⌘H are fixed.
        expect(appKeyAction(press('⌘Q'), keymap)).toBe('quit');
        expect(appKeyAction(press('⌘H'), keymap)).toBe('hide');
        const event = (text: string) => {
            const input = press(text);
            return { key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift };
        };
        expect(isClearKey(event('⌃⌘K'), keymap)).toBe(true);
        expect(isClearKey(event('⌘K'), keymap)).toBe(false);
        expect(isCommentKey(event('⇧⌘M'), keymap)).toBe(true);
        expect(pullRequestKeyAction(event('⌘O'), keymap)).toBe('openWorktree');
    });

    it('gives a shared key to the first command of the list', () => {
        const keymap = keymapOf({ newTab: ['CmdOrCtrl+D'] });
        expect(shortcutAction(press('⌘D'), keymap)).toBe('newTab');
    });
});

describe('reserved keys', () => {
    it('blocks the keys of macOS and the Edit menu, and warns for the find and terminal keys', () => {
        expect(reservedKey(chord('⌘Q'))?.level).toBe('blocked');
        expect(reservedKey(chord('⌘C'))?.level).toBe('blocked');
        expect(reservedKey(chord('⌃V'))?.level).toBe('blocked');
        expect(reservedKey(chord('⌘F'))?.level).toBe('warning');
        expect(reservedKey(chord('⌃R'))?.level).toBe('warning');
        expect(reservedKey(chord('⌃Tab'))).toBeUndefined();
        expect(reservedKey(chord('⇧⌘K'))).toBeUndefined();
    });

    it('needs ⌘ or ⌃, except for a function key', () => {
        expect(invalidKeyReason(chord('⌥P'))).toMatch(/no ⌘ or ⌃/);
        expect(invalidKeyReason(chord('P'))).toMatch(/no ⌘ or ⌃/);
        expect(invalidKeyReason(chord('F5'))).toBeUndefined();
        expect(invalidKeyReason(chord('⌃⌥T'))).toBeUndefined();
        expect(invalidKeyReason(chord('⌘F'))).toBeUndefined();
    });
});

describe('findConflicts', () => {
    it('finds no conflicts in the defaults', () => {
        expect(findConflicts(DEFAULT_KEYMAP)).toEqual([]);
    });

    it('finds two global commands with the same key', () => {
        expect(findConflicts(keymapOf({ newTab: ['CmdOrCtrl+D'] }))).toEqual([{ keys: '⌘D', commands: ['newTab', 'right'] }]);
    });

    it('finds a global command and a key of one place', () => {
        expect(findConflicts(keymapOf({ newTab: ['CmdOrCtrl+K'] }))).toEqual([{ keys: '⌘K', commands: ['newTab', 'clearTerminal'] }]);
    });

    it('allows the same key in two different places', () => {
        // The terminal and the diff never get the same key event.
        expect(findConflicts(keymapOf({ clearTerminal: ['CmdOrCtrl+Shift+M'] }))).toEqual([]);
        expect(findConflicts(keymapOf({ askAgent: ['CmdOrCtrl+Shift+M'] }))).toEqual([]);
        expect(findConflicts(keymapOf({ openWorktree: ['CmdOrCtrl+Shift+O'] }))).toEqual([{ keys: '⇧⌘O', commands: ['openWorktree', 'openOnHost'] }]);
    });
});

describe('assignKey', () => {
    it('gives the command the key and removes the key from the other command', () => {
        const changes = assignKey(DEFAULT_KEYMAP, command('newTab'), chord('⌘D'));
        expect(changes).toEqual([
            { command: 'newTab', keys: ['CmdOrCtrl+D'] },
            { command: 'right', keys: [] }
        ]);
    });

    it('resets a command that gets its default keys back', () => {
        const keymap = keymapOf({ commandPalette: ['CmdOrCtrl+Shift+K'] });
        expect(assignKey(keymap, command('commandPalette'), chord('⇧⌘P'))).toEqual([{ command: 'commandPalette', reset: true }]);
    });

    it('keeps the other key of a command with two keys', () => {
        expect(assignKey(DEFAULT_KEYMAP, command('newTab'), chord('⌃Tab'))).toEqual([
            { command: 'newTab', keys: ['Ctrl+Tab'] },
            { command: 'nextTab', keys: ['CmdOrCtrl+Shift+]'] }
        ]);
    });
});

describe('applyKeybindingChanges', () => {
    it('writes the changes, removes the defaults, and keeps the other entries', () => {
        const data = { newTab: 'Cmd+Shift+T', unknownThing: 'Cmd+J', commandPalette: 'Cmd+Shift+K' };
        const next = applyKeybindingChanges(data, [
            { command: 'commandPalette', reset: true },
            { command: 'right', keys: [] },
            { command: 'down', keys: ['⇧⌘D'] },
            { command: 'previousTab', keys: ['Cmd+Shift+[', 'Ctrl+Shift+Tab', 'Cmd+Alt+Left'] }
        ]);
        expect(next).toEqual({
            newTab: 'Cmd+Shift+T',
            unknownThing: 'Cmd+J',
            right: null,
            previousTab: ['CmdOrCtrl+Shift+[', 'Ctrl+Shift+Tab', 'CmdOrCtrl+Alt+Left']
        });
    });

    it('refuses a key that is not valid', () => {
        expect(() => applyKeybindingChanges({}, [{ command: 'newTab', keys: ['⌘Q'] }])).toThrow(/Quit ShipWarden/);
        expect(() => applyKeybindingChanges({}, [{ command: 'newTab', keys: ['Hyper+T'] }])).toThrow(/not a key/);
    });
});

describe('remapKeyText', () => {
    it('replaces the default keys in a help text', () => {
        const keymap = keymapOf({ newWorktree: ['CmdOrCtrl+Alt+N'], toggleSidebar: [] });
        expect(remapKeyText('Press ⌘N for a new worktree. Press ⌘T for a tab.', keymap)).toBe('Press ⌥⌘N for a new worktree. Press ⌘T for a tab.');
        expect(remapKeyText('Hide the sidebar (⌘B)', keymap)).toBe('Hide the sidebar (no key)');
        // ⇧⌘N is a different key, and ⌘Q is fixed.
        expect(remapKeyText('⇧⌘N opens a window. ⌘Q quits.', keymap)).toBe('⇧⌘N opens a window. ⌘Q quits.');
        // A letter key does not continue as a word.
        expect(remapKeyText('Send (⌘Enter)', keymap)).toBe('Send (⌘Enter)');
    });

    it('keeps a text with the default keymap', () => {
        expect(remapKeyText('Press ⌘N', DEFAULT_KEYMAP)).toBe('Press ⌘N');
    });
});

describe('shortcutRows', () => {
    it('shows the tab keys one by one after a change of one of them', () => {
        const rows = shortcutRows(keymapOf({ selectTab3: ['CmdOrCtrl+Alt+3'] }));
        expect(rows.some(row => row.range)).toBe(false);
        expect(rows.find(row => row.label === 'Select tab 3')?.keys).toEqual(['⌥⌘3']);
    });

    it('lists each command of KEY_COMMANDS', () => {
        expect(new Set(KEY_COMMANDS.map(item => item.id)).size).toBe(KEY_COMMANDS.length);
        expect(KEY_COMMANDS.every(item => item.defaults.length > 0)).toBe(true);
    });
});
