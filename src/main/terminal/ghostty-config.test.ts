import { describe, expect, it } from 'vitest';
import { findKeybind } from '@shared/keybinds';
import { decodeZigEscapes, normalizeColor, parseConfigEntries, parseKeybind, settingsFromGhosttyConfig } from './ghostty-config';

describe('parseConfigEntries', () => {
    it('reads key-value lines and ignores comments and blank lines', () => {
        const text = '# comment\n\nbackground = #0b0e14\nfont-family = "Berkeley Mono"\npalette = 1=#ea6c73\n';
        expect(parseConfigEntries(text)).toEqual([
            { key: 'background', value: '#0b0e14' },
            { key: 'font-family', value: 'Berkeley Mono' },
            { key: 'palette', value: '1=#ea6c73' }
        ]);
    });
});

describe('normalizeColor', () => {
    it.each([
        ['#0b0e14', '#0b0e14'],
        ['0b0e14', '#0b0e14'],
        ['fff', '#fff'],
        ['red', 'red'],
        ['', undefined]
    ])('converts %p to %p', (input, output) => {
        expect(normalizeColor(input)).toBe(output);
    });
});

describe('decodeZigEscapes', () => {
    it.each([
        ['\\n', '\n'],
        ['a\\tb', 'a\tb'],
        ['\\x1b[A', '\x1b[A'],
        ['\\u{1F600}', '😀'],
        ['\\\\', '\\'],
        ['plain', 'plain']
    ])('decodes %p', (input, output) => {
        expect(decodeZigEscapes(input)).toBe(output);
    });
});

describe('parseKeybind', () => {
    it('parses a text keybind', () => {
        expect(parseKeybind('shift+enter=text:\\n')).toEqual({
            kind: 'set',
            keybind: { key: 'enter', shift: true, ctrl: false, alt: false, meta: false, text: '\n' }
        });
    });

    it('maps the modifier names', () => {
        expect(parseKeybind('cmd+opt+control+k=text:x')).toEqual({
            kind: 'set',
            keybind: { key: 'k', shift: false, ctrl: true, alt: true, meta: true, text: 'x' }
        });
    });

    it('ignores global keybinds and key sequences', () => {
        expect(parseKeybind('global:ctrl+alt+super+backquote=toggle_quick_terminal')).toBeUndefined();
        expect(parseKeybind('ctrl+a>n=new_window')).toBeUndefined();
    });

    it('treats other actions as an unset of the chord', () => {
        expect(parseKeybind('super+c=copy_to_clipboard')).toEqual({
            kind: 'unset',
            trigger: { key: 'c', shift: false, ctrl: false, alt: false, meta: true }
        });
    });
});

describe('settingsFromGhosttyConfig', () => {
    const config = [
        'background = #0b0e14',
        'foreground = bfbdb6',
        'cursor-color = #bfbdb6',
        'cursor-text = #0b0e14',
        'selection-background = #1b3a5b',
        'palette = 0=#1e232b',
        'palette = 9=#f07178',
        'palette = 200=#000000',
        'font-family = Berkeley Mono',
        'font-size = 15',
        'cursor-style = bar',
        'cursor-style-blink = false',
        'keybind = global:ctrl+alt+super+backquote=toggle_quick_terminal',
        'keybind = ctrl+j=text:\\x1b[B'
    ].join('\n');

    it('maps colors, fonts, cursor and keybinds', () => {
        const settings = settingsFromGhosttyConfig(config, 'test');

        expect(settings.colors).toMatchObject({
            background: '#0b0e14',
            foreground: '#bfbdb6',
            cursor: '#bfbdb6',
            cursorAccent: '#0b0e14',
            selectionBackground: '#1b3a5b',
            black: '#1e232b',
            brightRed: '#f07178'
        });
        expect(settings.fontFamily).toBe('"Berkeley Mono", "JetBrains Mono", Menlo, monospace');
        expect(settings.fontSize).toBe(15);
        expect(settings.cursorStyle).toBe('bar');
        expect(settings.cursorBlink).toBe(false);
        expect(settings.source).toBe('test');
        expect(settings.keybinds.map(keybind => keybind.text)).toEqual(['\n', '\x1b[B']);
    });

    it('keeps the default shift+enter keybind when the config has none', () => {
        const settings = settingsFromGhosttyConfig('');
        const press = { key: 'Enter', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false };
        expect(findKeybind(settings.keybinds, press)?.text).toBe('\n');
    });

    it('removes all keybinds after "keybind = clear"', () => {
        expect(settingsFromGhosttyConfig('keybind = clear').keybinds).toEqual([]);
    });
});
