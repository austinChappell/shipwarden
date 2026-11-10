import type { TextKeybind } from './terminal';

/** The parts of a KeyboardEvent that a keybind compares. */
export interface KeyPress {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
}

const KEY_NAMES: Record<string, string> = {
    enter: 'enter',
    return: 'enter',
    tab: 'tab',
    space: 'space',
    ' ': 'space',
    escape: 'escape',
    backspace: 'backspace',
    delete: 'delete',
    arrowup: 'up',
    arrowdown: 'down',
    arrowleft: 'left',
    arrowright: 'right',
    up: 'up',
    down: 'down',
    left: 'left',
    right: 'right'
};

/** Converts a key name from Ghostty or from KeyboardEvent.key to one lowercase name. */
export function normalizeKeyName(key: string): string {
    const lower = key.toLowerCase();
    return KEY_NAMES[lower] ?? lower;
}

/** Returns true when the key press matches the keybind. */
export function matchesKeybind(keybind: TextKeybind, press: KeyPress): boolean {
    return (
        normalizeKeyName(press.key) === keybind.key &&
        press.shiftKey === keybind.shift &&
        press.ctrlKey === keybind.ctrl &&
        press.altKey === keybind.alt &&
        press.metaKey === keybind.meta
    );
}

/** Returns the first keybind that matches the key press, or undefined. */
export function findKeybind(keybinds: readonly TextKeybind[], press: KeyPress): TextKeybind | undefined {
    return keybinds.find(keybind => matchesKeybind(keybind, press));
}
