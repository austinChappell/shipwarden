import { describe, expect, it } from 'vitest';
import { chordId, formatAccelerator, formatChord, inputMatches, keyNamesOf, parseChord, parseChordSymbols, type KeyChord } from './key-chords';

const chord = (key: string, mods: Partial<KeyChord> = {}): KeyChord => ({ key, meta: false, control: false, alt: false, shift: false, ...mods });

describe('formatChord and formatAccelerator', () => {
    it('writes ⇧⌘P in the UI and CmdOrCtrl+Shift+P for Electron', () => {
        const palette = chord('P', { meta: true, shift: true });
        expect(formatChord(palette)).toBe('⇧⌘P');
        expect(formatAccelerator(palette)).toBe('CmdOrCtrl+Shift+P');
    });

    it('writes the modifiers in the order of macOS and the named keys as symbols', () => {
        const all = chord('Left', { meta: true, control: true, alt: true, shift: true });
        expect(formatChord(all)).toBe('⌃⌥⇧⌘←');
        expect(formatAccelerator(all)).toBe('CmdOrCtrl+Ctrl+Alt+Shift+Left');
        expect(formatChord(chord('Tab', { control: true }))).toBe('⌃Tab');
        expect(formatChord(chord('Enter', { meta: true }))).toBe('⌘↩');
        expect(formatAccelerator(chord(',', { meta: true }))).toBe('CmdOrCtrl+,');
    });
});

describe('parseChord', () => {
    it('reads accelerators with each modifier name, in any case', () => {
        expect(parseChord('CmdOrCtrl+Shift+P')).toEqual(chord('P', { meta: true, shift: true }));
        expect(parseChord('command+option+left')).toEqual(chord('Left', { meta: true, alt: true }));
        expect(parseChord('Ctrl+Tab')).toEqual(chord('Tab', { control: true }));
        expect(parseChord('Cmd+ArrowUp')).toEqual(chord('Up', { meta: true }));
        expect(parseChord('Cmd+[')).toEqual(chord('[', { meta: true }));
        expect(parseChord('F5')).toEqual(chord('F5'));
    });

    it('reads the form of the UI', () => {
        expect(parseChord('⇧⌘P')).toEqual(chord('P', { meta: true, shift: true }));
        expect(parseChord('⌘⇧P')).toEqual(chord('P', { meta: true, shift: true }));
        expect(parseChord('⌥⌘←')).toEqual(chord('Left', { meta: true, alt: true }));
        expect(parseChordSymbols('⌃⇧Tab')).toEqual(chord('Tab', { control: true, shift: true }));
    });

    it('rejects text that is not one key combination', () => {
        for (const text of ['', 'Cmd+', 'Cmd+Shift', 'Cmd+Cmd+P', 'Hyper+P', 'Cmd+Foo', '⌘⌘P', 'Cmd++', 'P+Cmd']) {
            expect(parseChord(text), text).toBeUndefined();
        }
    });

    it('gives back the same chord after a format', () => {
        const chords = [
            chord('P', { meta: true, shift: true }),
            chord('Left', { alt: true, meta: true }),
            chord('=', { meta: true }),
            chord('Tab', { control: true })
        ];
        for (const item of chords) {
            expect(parseChord(formatAccelerator(item))).toEqual(item);
            expect(parseChord(formatChord(item))).toEqual(item);
            expect(chordId(item)).toBe(formatAccelerator(item));
        }
    });
});

describe('keyNamesOf', () => {
    const input = (key: string, code: string | undefined, mods: Partial<KeyChord> = {}) => ({
        meta: true,
        control: false,
        alt: false,
        shift: false,
        key,
        code,
        ...mods
    });

    it('reads the code first, then the character', () => {
        expect(keyNamesOf(input('p', 'KeyP'))).toEqual(['P']);
        // A keyboard layout with "[" on another key.
        expect(keyNamesOf(input('{', 'Digit8', { shift: true }))).toEqual(['8', '[']);
        expect(keyNamesOf(input('3', undefined))).toEqual(['3']);
    });

    it('reads only the code with Option, and nothing for the number pad', () => {
        expect(keyNamesOf(input('¡', 'Digit1', { alt: true }))).toEqual(['1']);
        expect(keyNamesOf(input('1', undefined, { alt: true }))).toEqual([]);
        expect(keyNamesOf(input('1', 'Numpad1'))).toEqual([]);
    });

    it('matches a key event to a chord', () => {
        expect(inputMatches(input('P', 'KeyP', { shift: true }), chord('P', { meta: true, shift: true }))).toBe(true);
        expect(inputMatches(input('p', 'KeyP'), chord('P', { meta: true, shift: true }))).toBe(false);
        expect(inputMatches(input('ArrowLeft', 'ArrowLeft', { alt: true }), chord('Left', { meta: true, alt: true }))).toBe(true);
    });
});
