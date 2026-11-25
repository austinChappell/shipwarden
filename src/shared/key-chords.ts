/**
 * Key combinations ("chords") for the keyboard shortcuts. A chord is a set of modifier keys and one key, for example
 * ⇧⌘P. This module reads and writes chords in two text forms:
 *
 * - The form of the UI, with the modifier symbols in the order of macOS (⌃⌥⇧⌘), for example "⇧⌘P".
 * - The form of an Electron accelerator, for example "CmdOrCtrl+Shift+P". The keybindings file uses this form too.
 *
 * This module uses no Electron API and no browser API.
 */

/** A key combination. `key` is a key name of `KEY_NAMES`, for example "P", "1", "[", "Left", or "Tab". */
export interface KeyChord {
    key: string;
    meta: boolean;
    control: boolean;
    alt: boolean;
    shift: boolean;
}

/** The fields of a key event that the matching reads. Electron.Input and KeyboardEvent (after `inputOfEvent`) have these fields. */
export interface KeyInput {
    meta: boolean;
    shift: boolean;
    control: boolean;
    alt: boolean;
    key: string;
    code?: string;
}

/** The parts of a browser KeyboardEvent that the matching reads. */
export interface KeyEventFields {
    key: string;
    code?: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
}

/** Converts the fields of a browser KeyboardEvent to a `KeyInput`. */
export function inputOfEvent(event: KeyEventFields): KeyInput {
    return { meta: event.metaKey, shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, key: event.key, code: event.code };
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const DIGITS = '0123456789'.split('');
const FUNCTION_KEYS = Array.from({ length: 12 }, (_, index) => `F${index + 1}`);
const PUNCTUATION = ['[', ']', ',', '.', '/', ';', "'", '`', '-', '=', '\\'];
const NAMED_KEYS = ['Left', 'Right', 'Up', 'Down', 'Tab', 'Enter', 'Escape', 'Space', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'];

/** All key names that a chord can have. */
export const KEY_NAMES: ReadonlySet<string> = new Set([...LETTERS, ...DIGITS, ...FUNCTION_KEYS, ...PUNCTUATION, ...NAMED_KEYS]);

/** The key name of each KeyboardEvent code that is not a letter or a digit. */
const CODE_KEYS: Record<string, string> = {
    BracketLeft: '[',
    BracketRight: ']',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    Backslash: '\\',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    Tab: 'Tab',
    Enter: 'Enter',
    Escape: 'Escape',
    Space: 'Space',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown'
};

/**
 * The key name of each character or key value of a KeyboardEvent. Shift changes the character (⇧[ gives "{"), so the
 * shifted characters of a US keyboard give the key under them.
 */
const CHARACTER_KEYS: Record<string, string> = {
    '{': '[',
    '}': ']',
    '<': ',',
    '>': '.',
    '?': '/',
    ':': ';',
    '"': "'",
    '~': '`',
    _: '-',
    '+': '=',
    '|': '\\',
    ')': '0',
    '!': '1',
    '@': '2',
    '#': '3',
    $: '4',
    '%': '5',
    '^': '6',
    '&': '7',
    '*': '8',
    '(': '9',
    ' ': 'Space',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    Tab: 'Tab',
    Enter: 'Enter',
    Escape: 'Escape',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown'
};

/** Returns the key name of a KeyboardEvent code, for example "P" for "KeyP". Returns undefined for other codes. */
export function keyOfCode(code: string): string | undefined {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-2])$/.test(code)) return code;
    return CODE_KEYS[code];
}

/** Returns the key name of a KeyboardEvent key value, for example "P" for "p" and "[" for "{". */
function keyOfCharacter(key: string): string | undefined {
    if (/^[a-z]$/i.test(key)) return key.toUpperCase();
    if (/^\d$/.test(key) || PUNCTUATION.includes(key)) return key;
    if (/^F([1-9]|1[0-2])$/.test(key)) return key;
    return CHARACTER_KEYS[key];
}

/**
 * Returns the key names that a key event can mean, the most certain name first.
 *
 * - The code of the key comes first. Option and Shift change the character on macOS, but not the code.
 * - The character comes second, for a keyboard layout with the key at another place (for example "[" on a key with
 *   the code "Digit8"), and for an event without a code.
 * - With Option, the character is not the key (⌥1 gives "¡"), so only the code counts.
 * - A key of the number pad is not a digit key. Only its code counts, and the code has no key name.
 */
export function keyNamesOf(input: KeyInput): string[] {
    const names: string[] = [];
    const fromCode = input.code ? keyOfCode(input.code) : undefined;
    if (fromCode) names.push(fromCode);
    const numpad = input.code?.startsWith('Numpad') ?? false;
    if (!input.alt && !numpad) {
        const fromCharacter = keyOfCharacter(input.key);
        // A digit from the character counts only without a code. With a code, the code tells the digit.
        const digitWithCode = !!input.code && !!fromCharacter && /^\d$/.test(fromCharacter) && /^\d$/.test(input.key);
        if (fromCharacter && !names.includes(fromCharacter) && !digitWithCode) names.push(fromCharacter);
    }
    return names;
}

/** Returns a unique text for a chord. Two chords are the same key combination when their IDs are equal. */
export function chordId(chord: KeyChord): string {
    return formatAccelerator(chord);
}

/** Returns true when the two chords are the same key combination. */
export function sameChord(a: KeyChord, b: KeyChord): boolean {
    return a.key === b.key && a.meta === b.meta && a.control === b.control && a.alt === b.alt && a.shift === b.shift;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The UI form: "⇧⌘P"                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The symbol of each named key in the UI. */
const KEY_SYMBOLS: Record<string, string> = {
    Left: '←',
    Right: '→',
    Up: '↑',
    Down: '↓',
    Enter: '↩',
    Escape: '⎋',
    Backspace: '⌫',
    Delete: '⌦',
    PageUp: '⇞',
    PageDown: '⇟',
    Home: '↖',
    End: '↘'
};

const SYMBOL_KEYS: Record<string, string> = Object.fromEntries([...Object.entries(KEY_SYMBOLS).map(([name, symbol]) => [symbol, name]), ['↵', 'Enter']]);

/** Writes a chord in the form of the UI, with the modifiers in the order of macOS (⌃⌥⇧⌘), for example "⇧⌘P". */
export function formatChord(chord: KeyChord): string {
    return `${chord.control ? '⌃' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.meta ? '⌘' : ''}${KEY_SYMBOLS[chord.key] ?? chord.key}`;
}

/** Reads a chord in the form of the UI, for example "⇧⌘P" or "⌃Tab". The modifiers can be in any order. */
export function parseChordSymbols(text: string): KeyChord | undefined {
    const match = /^([⌃⌥⇧⌘]*)(.+)$/u.exec(text.trim());
    if (!match) return undefined;
    const modifiers = [...match[1]];
    if (new Set(modifiers).size !== modifiers.length) return undefined;
    const key = keyOfName(match[2]);
    if (!key) return undefined;
    return { key, meta: modifiers.includes('⌘'), control: modifiers.includes('⌃'), alt: modifiers.includes('⌥'), shift: modifiers.includes('⇧') };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The accelerator form: "CmdOrCtrl+Shift+P"                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The modifier of each modifier name in an accelerator. The names do not depend on the case. */
const MODIFIER_NAMES: Record<string, 'meta' | 'control' | 'alt' | 'shift'> = {
    cmdorctrl: 'meta',
    commandorcontrol: 'meta',
    cmd: 'meta',
    command: 'meta',
    meta: 'meta',
    super: 'meta',
    ctrl: 'control',
    control: 'control',
    alt: 'alt',
    option: 'alt',
    opt: 'alt',
    shift: 'shift'
};

/** Other names of the named keys in an accelerator, in lowercase. */
const KEY_ALIASES: Record<string, string> = {
    arrowleft: 'Left',
    arrowright: 'Right',
    arrowup: 'Up',
    arrowdown: 'Down',
    return: 'Enter',
    esc: 'Escape',
    del: 'Delete',
    pgup: 'PageUp',
    pgdown: 'PageDown'
};

/** Returns the key name of a key in a text form, for example "Left" for "left", "←", or "ArrowLeft". */
function keyOfName(name: string): string | undefined {
    if (SYMBOL_KEYS[name]) return SYMBOL_KEYS[name];
    if (/^[a-z]$/i.test(name)) return name.toUpperCase();
    if (KEY_NAMES.has(name)) return name;
    const lower = name.toLowerCase();
    if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
    return [...KEY_NAMES].find(known => known.toLowerCase() === lower);
}

/**
 * Writes a chord as an Electron accelerator, for example "CmdOrCtrl+Shift+P". ShipWarden runs on macOS only, so
 * "CmdOrCtrl" is the ⌘ key. "Ctrl" is the Control key (⌃).
 */
export function formatAccelerator(chord: KeyChord): string {
    const parts = [chord.meta && 'CmdOrCtrl', chord.control && 'Ctrl', chord.alt && 'Alt', chord.shift && 'Shift', chord.key];
    return parts.filter(Boolean).join('+');
}

/**
 * Reads a chord as an accelerator, for example "CmdOrCtrl+Shift+P", "Cmd+Alt+Left", or "Ctrl+Tab". Also reads the
 * form of the UI, for example "⇧⌘P". Returns undefined for text that is not one key combination.
 */
export function parseChord(text: string): KeyChord | undefined {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    if (!trimmed.includes('+') || /^[⌃⌥⇧⌘]/u.test(trimmed)) {
        const symbols = parseChordSymbols(trimmed);
        if (symbols) return symbols;
        if (!trimmed.includes('+')) return undefined;
    }
    const parts = trimmed.split('+').map(part => part.trim());
    const name = parts.pop();
    if (!name || parts.some(part => !part)) return undefined;
    const chord: KeyChord = { key: '', meta: false, control: false, alt: false, shift: false };
    for (const part of parts) {
        const modifier = MODIFIER_NAMES[part.toLowerCase()];
        if (!modifier || chord[modifier]) return undefined;
        chord[modifier] = true;
    }
    const key = keyOfName(name);
    if (!key) return undefined;
    chord.key = key;
    return chord;
}

/** Returns true when the key event is the chord. */
export function inputMatches(input: KeyInput, chord: KeyChord): boolean {
    if (input.meta !== chord.meta || input.control !== chord.control || input.alt !== chord.alt || input.shift !== chord.shift) return false;
    return keyNamesOf(input).includes(chord.key);
}
