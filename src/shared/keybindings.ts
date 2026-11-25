/**
 * The keybindings of the user. The file ~/.shipwarden/keybindings.json changes the default keys of `shortcuts.ts`.
 *
 * - The file is one JSON object. Each name is a command ID of `KEY_COMMANDS`. Each value is one key, a list of keys,
 *   or null for no key. For example: { "commandPalette": "CmdOrCtrl+Shift+K", "newTab": null }.
 * - A key is an Electron accelerator ("CmdOrCtrl+Alt+Left") or a key in the form of the UI ("⌥⌘←").
 * - ShipWarden ignores an entry that is not valid and shows a warning in Settings › Keyboard. The command then keeps
 *   its default key.
 * - Two commands can have the same key. Settings › Keyboard shows the conflict. The command that is first in
 *   `KEY_COMMANDS` gets the key.
 *
 * This module uses no Electron API and no browser API.
 */
import { chordId, formatAccelerator, formatChord, parseChord, sameChord, type KeyChord } from './key-chords';
import { buildKeymap, isKeyCommandId, KEY_COMMANDS, keyCommand, type KeyCommand, type KeyCommandId, type Keymap } from './shortcuts';

/** The name of the keybindings file in ~/.shipwarden. */
export const KEYBINDINGS_FILE_NAME = 'keybindings.json';

/** The keys of the user for each changed command, as accelerators. An empty list means no key. */
export type KeybindingOverrides = Partial<Record<KeyCommandId, string[]>>;

/** The state of the keybindings file, for the page. */
export interface KeybindingsState {
    /** The path of the file. */
    file: string;
    /** The valid entries of the file. */
    overrides: KeybindingOverrides;
    /** One message for each entry that ShipWarden ignored, or for a file that ShipWarden could not read. */
    problems: string[];
}

/** A change of one command: new keys (an empty list for no key), or `reset` for the default keys. */
export type KeybindingChange = { command: KeyCommandId; keys: string[] } | { command: KeyCommandId; reset: true };

/* ------------------------------------------------------------------------------------------------------------------ */
/* Reserved keys                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * A key that macOS, the Edit menu, or the terminal uses.
 * - "blocked": a command cannot get the key. ShipWarden cannot take it, or the app needs it.
 * - "warning": a command can get the key, but then the other use of the key stops.
 */
export interface ReservedKey {
    keys: string;
    label: string;
    level: 'blocked' | 'warning';
}

/** The keys that a command cannot get, or gets with a warning. */
export const RESERVED_KEYS: readonly ReservedKey[] = [
    { keys: '⌘Q', label: 'Quit ShipWarden', level: 'blocked' },
    { keys: '⌥⌘Q', label: 'Quit and Keep Windows (macOS)', level: 'blocked' },
    { keys: '⌘H', label: 'Hide ShipWarden', level: 'blocked' },
    { keys: '⌥⌘H', label: 'Hide Others', level: 'blocked' },
    { keys: '⌘M', label: 'Minimize the window', level: 'blocked' },
    { keys: '⇧⌘W', label: 'Close the window', level: 'blocked' },
    { keys: '⌘A', label: 'Select all', level: 'blocked' },
    { keys: '⌘C', label: 'Copy', level: 'blocked' },
    { keys: '⌘V', label: 'Paste', level: 'blocked' },
    { keys: '⌘X', label: 'Cut', level: 'blocked' },
    { keys: '⌘Z', label: 'Undo', level: 'blocked' },
    { keys: '⇧⌘Z', label: 'Redo', level: 'blocked' },
    { keys: '⌘Tab', label: 'Switch apps (macOS)', level: 'blocked' },
    { keys: '⌘Space', label: 'Spotlight (macOS)', level: 'blocked' },
    { keys: '⌘`', label: 'Switch windows (macOS)', level: 'blocked' },
    { keys: '⌃V', label: 'Paste an image into Claude Code or Codex', level: 'blocked' },
    { keys: '⌘F', label: 'Find', level: 'warning' },
    { keys: '⌘G', label: 'Find the next match', level: 'warning' },
    { keys: '⇧⌘G', label: 'Find the previous match', level: 'warning' },
    { keys: '⌘S', label: 'Save the file', level: 'warning' },
    { keys: '⌘L', label: 'Select the address bar of a browser tab', level: 'warning' },
    { keys: '⌘R', label: 'Load the page again', level: 'warning' },
    { keys: '⌥⌘I', label: 'Developer tools', level: 'warning' },
    { keys: '⌘0', label: 'Actual size', level: 'warning' },
    { keys: '⌘=', label: 'Zoom in', level: 'warning' },
    { keys: '⌘-', label: 'Zoom out', level: 'warning' },
    { keys: '⌃⌘F', label: 'Full screen', level: 'warning' }
];

const RESERVED_CHORDS = RESERVED_KEYS.map(item => ({ ...item, chord: parseChord(item.keys) as KeyChord }));

/** Returns the reserved use of a key, or undefined for a free key. ⌃ and a letter without ⌘ is a key of the terminal. */
export function reservedKey(chord: KeyChord): ReservedKey | undefined {
    const listed = RESERVED_CHORDS.find(item => sameChord(item.chord, chord));
    if (listed) return listed;
    if (chord.control && !chord.meta && /^[A-Z[\]\\]$/.test(chord.key)) {
        return { keys: formatChord(chord), label: 'A control key of the terminal, for example ⌃C', level: 'warning' };
    }
    return undefined;
}

/**
 * Returns a message when a command cannot get the key, or undefined when it can. A key needs ⌘ or ⌃, because a key
 * with only ⌥ or ⇧ types a character. The function keys F1 to F12 can be alone.
 */
export function invalidKeyReason(chord: KeyChord): string | undefined {
    const label = formatChord(chord);
    if (!chord.meta && !chord.control && !/^F\d+$/.test(chord.key)) return `${label} has no ⌘ or ⌃. A key without them types a character.`;
    const reserved = reservedKey(chord);
    if (reserved?.level === 'blocked') return `${label} is the key of "${reserved.label}". You cannot change it.`;
    return undefined;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The file                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The valid entries of a file, and a message for each entry that is not valid. */
export interface ParsedKeybindings {
    overrides: KeybindingOverrides;
    problems: string[];
}

/**
 * Reads the text of the keybindings file. It never throws. An empty text is an empty file. A text that is not a JSON
 * object gives no entries and one problem. An entry that is not valid gives a problem, and the other entries stay.
 */
export function parseKeybindingsFile(text: string): ParsedKeybindings {
    if (!text.trim()) return { overrides: {}, problems: [] };
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch (error) {
        return { overrides: {}, problems: [`The file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { overrides: {}, problems: ['The file must contain one JSON object, for example { "commandPalette": "CmdOrCtrl+Shift+K" }.'] };
    }
    return validateKeybindings(data as Record<string, unknown>);
}

/** Checks the entries of the keybindings object. */
export function validateKeybindings(data: Record<string, unknown>): ParsedKeybindings {
    const overrides: KeybindingOverrides = {};
    const problems: string[] = [];
    for (const [name, value] of Object.entries(data)) {
        if (!isKeyCommandId(name)) {
            problems.push(`"${name}" is not a command. ShipWarden ignored it.`);
            continue;
        }
        const result = readEntry(value);
        if (typeof result === 'string') problems.push(`"${name}": ${result} The command keeps its default key.`);
        else overrides[name] = result;
    }
    return { overrides, problems };
}

/** Reads the value of one entry. Returns the keys as accelerators, or a message. */
function readEntry(value: unknown): string[] | string {
    if (value === null) return [];
    const texts = typeof value === 'string' ? [value] : Array.isArray(value) ? value : undefined;
    if (!texts) return 'The value must be a key, a list of keys, or null.';
    const chords: KeyChord[] = [];
    for (const text of texts) {
        if (typeof text !== 'string') return 'Each key must be a text, for example "CmdOrCtrl+Shift+P".';
        const chord = parseChord(text);
        if (!chord) return `"${text}" is not a key. Write a key as "CmdOrCtrl+Shift+P" or "⇧⌘P".`;
        const reason = invalidKeyReason(chord);
        if (reason) return reason;
        if (!chords.some(other => sameChord(other, chord))) chords.push(chord);
    }
    return chords.map(formatAccelerator);
}

/**
 * Applies changes to the object of the file and returns the new object. A key list that is equal to the defaults
 * removes the entry, so the file keeps only the changes. Other entries stay as they are, also entries that are not
 * valid.
 */
export function applyKeybindingChanges(data: Record<string, unknown>, changes: readonly KeybindingChange[]): Record<string, unknown> {
    const next = { ...data };
    for (const change of changes) {
        const command = keyCommand(change.command);
        if (!command) throw new Error(`"${change.command}" is not a command.`);
        if ('reset' in change) {
            delete next[command.id];
            continue;
        }
        const chords = change.keys.map(text => {
            const chord = parseChord(text);
            if (!chord) throw new Error(`"${text}" is not a key.`);
            const reason = invalidKeyReason(chord);
            if (reason) throw new Error(reason);
            return chord;
        });
        if (sameChords(chords, command.defaults)) delete next[command.id];
        else next[command.id] = chords.length === 0 ? null : chords.length === 1 ? formatAccelerator(chords[0]) : chords.map(formatAccelerator);
    }
    return next;
}

function sameChords(a: readonly KeyChord[], b: readonly KeyChord[]): boolean {
    return a.length === b.length && a.every((chord, index) => sameChord(chord, b[index]));
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The keymap                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Returns the keys of each command: the keys of the user, else the defaults. */
export function mergeKeybindings(overrides: KeybindingOverrides): Record<KeyCommandId, KeyChord[]> {
    const keys = {} as Record<KeyCommandId, KeyChord[]>;
    for (const command of KEY_COMMANDS) {
        const own = overrides[command.id];
        keys[command.id] = own ? own.map(text => parseChord(text)).filter((chord): chord is KeyChord => !!chord) : [...command.defaults];
    }
    return keys;
}

const keymaps = new WeakMap<KeybindingOverrides, Keymap>();

/** Returns the keymap of the user keybindings. The same overrides object gives the same keymap object. */
export function keymapOf(overrides: KeybindingOverrides): Keymap {
    let keymap = keymaps.get(overrides);
    if (!keymap) {
        const merged = mergeKeybindings(overrides);
        // A command with its default keys keeps the default list, so a check for the defaults can compare the lists.
        const keys: Partial<Record<KeyCommandId, KeyChord[]>> = {};
        for (const command of KEY_COMMANDS) if (overrides[command.id]) keys[command.id] = merged[command.id];
        keymap = buildKeymap(keys);
        keymaps.set(overrides, keymap);
    }
    return keymap;
}

/** Returns true when the command has its default keys. */
export function hasDefaultKeys(keymap: Keymap, command: KeyCommand): boolean {
    return sameChords(keymap.keys[command.id], command.defaults);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Conflicts                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Returns true when two commands can get the same key event: one of them is global, or both work in the same place. */
export function scopesOverlap(a: KeyCommand, b: KeyCommand): boolean {
    return a.scope === 'global' || b.scope === 'global' || a.scope === b.scope;
}

/** Two or more commands with the same key. The first command gets the key. */
export interface KeyConflict {
    /** The key in the form of the UI. */
    keys: string;
    commands: KeyCommandId[];
}

/** Returns each key that two or more commands share, in the order of the commands. */
export function findConflicts(keymap: Keymap): KeyConflict[] {
    const conflicts: KeyConflict[] = [];
    for (const [id, commands] of keymap.byChord) {
        if (commands.length < 2) continue;
        const clashing = commands.filter((command, index) =>
            commands.some((other, otherIndex) => otherIndex !== index && scopesOverlap(keyCommand(command) as KeyCommand, keyCommand(other) as KeyCommand))
        );
        if (clashing.length > 1) {
            const chord = keymap.keys[clashing[0]].find(item => chordId(item) === id) as KeyChord;
            conflicts.push({ keys: formatChord(chord), commands: clashing });
        }
    }
    return conflicts;
}

/** Returns the other commands that have the key and can get the same key event as the command. */
export function commandsWithKey(keymap: Keymap, command: KeyCommand, chord: KeyChord): KeyCommand[] {
    return (keymap.byChord.get(chordId(chord)) ?? [])
        .filter(id => id !== command.id)
        .map(id => keyCommand(id) as KeyCommand)
        .filter(other => scopesOverlap(command, other));
}

/**
 * Returns the changes that give the command the one key. Each other command with the key loses the key ("Replace" in
 * Settings › Keyboard). A command that then has its default keys gets a reset.
 */
export function assignKey(keymap: Keymap, command: KeyCommand, chord: KeyChord): KeybindingChange[] {
    const changes: KeybindingChange[] = [keysChange(command, [chord])];
    for (const other of commandsWithKey(keymap, command, chord)) {
        changes.push(
            keysChange(
                other,
                keymap.keys[other.id].filter(item => !sameChord(item, chord))
            )
        );
    }
    return changes;
}

function keysChange(command: KeyCommand, chords: readonly KeyChord[]): KeybindingChange {
    return sameChords(chords, command.defaults) ? { command: command.id, reset: true } : { command: command.id, keys: chords.map(formatAccelerator) };
}
