import type { TerminalColors, TerminalSettings, TextKeybind } from '@shared/terminal';
import { normalizeKeyName } from '@shared/keybinds';

/** The font that Ghostty uses when the config has no font-family. Ghostty includes this font. */
const GHOSTTY_DEFAULT_FONT = 'JetBrains Mono';
const FALLBACK_FONTS = ['Menlo', 'monospace'];

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
    fontFamily: [`"${GHOSTTY_DEFAULT_FONT}"`, ...FALLBACK_FONTS].join(', '),
    fontSize: 13,
    cursorStyle: 'block',
    cursorBlink: true,
    colors: {
        background: '#0b0e14',
        foreground: '#bfbdb6'
    },
    keybinds: [
        // Claude Code and other agents use shift+enter for a new line in the prompt.
        { key: 'enter', shift: true, ctrl: false, alt: false, meta: false, text: '\n' }
    ]
};

const PALETTE_NAMES: (keyof TerminalColors)[] = [
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
];

const SIMPLE_COLORS: Record<string, keyof TerminalColors> = {
    'background': 'background',
    'foreground': 'foreground',
    'cursor-color': 'cursor',
    'cursor-text': 'cursorAccent',
    'selection-background': 'selectionBackground',
    'selection-foreground': 'selectionForeground'
};

/** One `key = value` line of a Ghostty config. */
export interface ConfigEntry {
    key: string;
    value: string;
}

/** Splits Ghostty config text into entries. The function ignores comments and blank lines. */
export function parseConfigEntries(text: string): ConfigEntry[] {
    const entries: ConfigEntry[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        const equals = line.indexOf('=');
        if (equals === -1) {
            continue;
        }
        const key = line.slice(0, equals).trim();
        let value = line.slice(equals + 1).trim();
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
        }
        entries.push({ key, value });
    }
    return entries;
}

/** Adds "#" to a hex color without it. Ghostty accepts both forms. CSS accepts only the form with "#". */
export function normalizeColor(value: string): string | undefined {
    const color = value.trim();
    if (!color) {
        return undefined;
    }
    if (/^[0-9a-f]{6}$/i.test(color) || /^[0-9a-f]{3}$/i.test(color)) {
        return `#${color}`;
    }
    return color;
}

/**
 * Decodes the escape sequences in a Ghostty `text:` action.
 * Ghostty uses the escape syntax of Zig string literals.
 */
export function decodeZigEscapes(value: string): string {
    let result = '';
    for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if (char !== '\\' || i === value.length - 1) {
            result += char;
            continue;
        }
        const next = value[++i];
        switch (next) {
            case 'n': result += '\n'; break;
            case 'r': result += '\r'; break;
            case 't': result += '\t'; break;
            case '\\': result += '\\'; break;
            case '\'': result += '\''; break;
            case '"': result += '"'; break;
            case 'x': {
                const hex = value.slice(i + 1, i + 3);
                if (/^[0-9a-f]{2}$/i.test(hex)) {
                    result += String.fromCharCode(parseInt(hex, 16));
                    i += 2;
                } else {
                    result += '\\x';
                }
                break;
            }
            case 'u': {
                const match = /^\{([0-9a-f]{1,6})\}/i.exec(value.slice(i + 1));
                if (match) {
                    result += String.fromCodePoint(parseInt(match[1], 16));
                    i += match[0].length;
                } else {
                    result += '\\u';
                }
                break;
            }
            default:
                result += '\\' + next;
        }
    }
    return result;
}

const MODIFIERS: Record<string, 'shift' | 'ctrl' | 'alt' | 'meta'> = {
    shift: 'shift',
    ctrl: 'ctrl',
    control: 'ctrl',
    alt: 'alt',
    opt: 'alt',
    option: 'alt',
    super: 'meta',
    cmd: 'meta',
    command: 'meta'
};

type KeybindChange =
    | { kind: 'clear' }
    | { kind: 'set'; keybind: TextKeybind }
    | { kind: 'unset'; trigger: Omit<TextKeybind, 'text'> };

/**
 * Parses one `keybind` value, for example `shift+enter=text:\n`.
 * The function supports only single-chord triggers. It ignores `global:` keybinds and key sequences.
 */
export function parseKeybind(value: string): KeybindChange | undefined {
    if (value.trim() === 'clear') {
        return { kind: 'clear' };
    }
    const equals = value.indexOf('=');
    if (equals <= 0) {
        return undefined;
    }
    let trigger = value.slice(0, equals).trim();
    const action = value.slice(equals + 1).trim();

    // Prefixes such as "all:" and "unconsumed:" change scope. "global:" keybinds belong to the OS, not to a terminal.
    while (/^(all|global|unconsumed|performable):/.test(trigger)) {
        if (trigger.startsWith('global:')) {
            return undefined;
        }
        trigger = trigger.slice(trigger.indexOf(':') + 1);
    }
    if (trigger.includes('>')) {
        return undefined;
    }

    const parsed: Omit<TextKeybind, 'text'> = { key: '', shift: false, ctrl: false, alt: false, meta: false };
    for (const part of trigger.split('+')) {
        const name = part.trim().toLowerCase();
        const modifier = MODIFIERS[name];
        if (modifier) {
            parsed[modifier] = true;
        } else if (name && !parsed.key) {
            parsed.key = normalizeKeyName(name.replace(/^physical:/, ''));
        } else {
            return undefined;
        }
    }
    if (!parsed.key) {
        return undefined;
    }
    if (action === 'unbind') {
        return { kind: 'unset', trigger: parsed };
    }
    if (action.startsWith('text:')) {
        return { kind: 'set', keybind: { ...parsed, text: decodeZigEscapes(action.slice('text:'.length)) } };
    }
    // ShipWarden does not run other Ghostty actions. Such a keybind removes an earlier text keybind for the same chord.
    return { kind: 'unset', trigger: parsed };
}

function sameTrigger(a: Omit<TextKeybind, 'text'>, b: Omit<TextKeybind, 'text'>): boolean {
    return a.key === b.key && a.shift === b.shift && a.ctrl === b.ctrl && a.alt === b.alt && a.meta === b.meta;
}

/** Converts Ghostty config text to terminal settings. Values that the config does not set come from the defaults. */
export function settingsFromGhosttyConfig(text: string, source?: string): TerminalSettings {
    const colors: TerminalColors = { ...DEFAULT_TERMINAL_SETTINGS.colors };
    const fonts: string[] = [];
    let fontSize = DEFAULT_TERMINAL_SETTINGS.fontSize;
    let cursorStyle = DEFAULT_TERMINAL_SETTINGS.cursorStyle;
    let cursorBlink = DEFAULT_TERMINAL_SETTINGS.cursorBlink;
    let keybinds: TextKeybind[] = [...DEFAULT_TERMINAL_SETTINGS.keybinds];

    for (const { key, value } of parseConfigEntries(text)) {
        if (key in SIMPLE_COLORS) {
            const color = normalizeColor(value);
            if (color) {
                colors[SIMPLE_COLORS[key]] = color;
            }
        } else if (key === 'palette') {
            const match = /^(\d+)\s*=\s*(.+)$/.exec(value);
            const index = match ? Number(match[1]) : -1;
            const color = match ? normalizeColor(match[2]) : undefined;
            if (index >= 0 && index < PALETTE_NAMES.length && color) {
                colors[PALETTE_NAMES[index]] = color;
            }
        } else if (key === 'font-family') {
            // An empty value clears the earlier fonts.
            if (value) {
                fonts.push(value);
            } else {
                fonts.length = 0;
            }
        } else if (key === 'font-size') {
            const size = Number(value);
            if (Number.isFinite(size) && size > 0) {
                fontSize = size;
            }
        } else if (key === 'cursor-style') {
            cursorStyle = value === 'bar' ? 'bar' : value === 'underline' ? 'underline' : 'block';
        } else if (key === 'cursor-style-blink') {
            cursorBlink = value !== 'false';
        } else if (key === 'keybind') {
            const change = parseKeybind(value);
            if (change?.kind === 'clear') {
                keybinds = [];
            } else if (change?.kind === 'set') {
                keybinds = keybinds.filter(existing => !sameTrigger(existing, change.keybind));
                keybinds.push(change.keybind);
            } else if (change?.kind === 'unset') {
                keybinds = keybinds.filter(existing => !sameTrigger(existing, change.trigger));
            }
        }
    }

    const fontFamily = [...fonts, GHOSTTY_DEFAULT_FONT]
        .filter((font, index, all) => all.indexOf(font) === index)
        .map(font => `"${font}"`)
        .concat(FALLBACK_FONTS)
        .join(', ');

    return { fontFamily, fontSize, cursorStyle, cursorBlink, colors, keybinds, source };
}
