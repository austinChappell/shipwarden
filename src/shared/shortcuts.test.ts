import { describe, expect, it } from 'vitest';
import { appKeyAction, shortcutAction } from './shortcuts';

const key = (change: Partial<Parameters<typeof shortcutAction>[0]>) =>
    shortcutAction({ type: 'keyDown', meta: true, shift: false, control: false, alt: false, key: 'd', code: 'KeyD', ...change });

describe('shortcutAction', () => {
    it('finds the tab and split keys of Ghostty', () => {
        expect(key({})).toBe('right');
        expect(key({ shift: true, key: 'D' })).toBe('down');
        expect(key({ key: 't', code: 'KeyT' })).toBe('newTab');
        expect(key({ key: 'w', code: 'KeyW' })).toBe('close');
        expect(key({ key: '[', code: 'BracketLeft' })).toBe('previous');
        expect(key({ key: ']', code: 'BracketRight' })).toBe('next');
    });

    it('ignores other keys, key up, and other modifiers', () => {
        expect(key({ type: 'keyUp' })).toBeUndefined();
        expect(key({ meta: false })).toBeUndefined();
        expect(key({ alt: true })).toBeUndefined();
        expect(key({ control: true })).toBeUndefined();
        expect(key({ key: 'k', code: 'KeyK' })).toBeUndefined();
        // ⇧⌘W closes the window, so it is not a workspace action.
        expect(key({ shift: true, key: 'W', code: 'KeyW' })).toBeUndefined();
        expect(key({ shift: true, key: '{', code: 'BracketLeft' })).toBeUndefined();
    });
});

describe('appKeyAction', () => {
    const key = (code: string, mods: Partial<{ meta: boolean; shift: boolean; alt: boolean; control: boolean }> = {}) =>
        ({ type: 'keyDown', meta: true, shift: false, alt: false, control: false, key: code.replace('Key', '').toLowerCase(), code, ...mods });

    it('finds the quit, settings and hide keys', () => {
        expect(appKeyAction(key('KeyQ'))).toBe('quit');
        expect(appKeyAction(key('KeyQ', { shift: true, alt: true }))).toBe('quitAndStop');
        expect(appKeyAction({ ...key('Comma'), key: ',' })).toBe('settings');
        expect(appKeyAction(key('KeyH'))).toBe('hide');
    });

    it('leaves other keys and the keys of macOS', () => {
        // ⌥⌘Q is "Quit and Keep Windows" of macOS, and ⌥⌘H is "Hide Others".
        expect(appKeyAction(key('KeyQ', { alt: true }))).toBeUndefined();
        expect(appKeyAction(key('KeyH', { alt: true }))).toBeUndefined();
        expect(appKeyAction(key('KeyQ', { meta: false }))).toBeUndefined();
        expect(appKeyAction(key('KeyQ', { control: true }))).toBeUndefined();
        expect(appKeyAction(key('KeyT'))).toBeUndefined();
    });
});
