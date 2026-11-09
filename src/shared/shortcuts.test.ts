import { describe, expect, it } from 'vitest';
import { appKeyAction, isClearKey, isCtrlV, isImageOnlyPaste, shortcutAction } from './shortcuts';

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

    it('is ⇧⌘E for the focus in the file explorer, and ⌘E is not a shortcut', () => {
        expect(key({ shift: true, key: 'E', code: 'KeyE' })).toBe('focusExplorer');
        expect(key({ key: 'e', code: 'KeyE' })).toBeUndefined();
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

describe('toggleSidebar', () => {
    it('is ⌘B', () => {
        expect(shortcutAction({ type: 'keyDown', meta: true, shift: false, control: false, alt: false, key: 'b', code: 'KeyB' })).toBe('toggleSidebar');
        expect(shortcutAction({ type: 'keyDown', meta: true, shift: true, control: false, alt: false, key: 'b', code: 'KeyB' })).toBeUndefined();
    });

    it('is ⌥⌘B for the right panel, and other ⌥⌘ keys are not shortcuts', () => {
        // With Option, macOS sends another character in "key" (for example "∫"). The code stays "KeyB".
        expect(shortcutAction({ type: 'keyDown', meta: true, shift: false, control: false, alt: true, key: '∫', code: 'KeyB' })).toBe('toggleRightPanel');
        expect(shortcutAction({ type: 'keyDown', meta: true, shift: false, control: false, alt: true, key: '†', code: 'KeyT' })).toBeUndefined();
    });
});

describe('newWorktree', () => {
    it('is ⌘N without other modifier keys', () => {
        expect(key({ key: 'n', code: 'KeyN' })).toBe('newWorktree');
        expect(key({ shift: true, key: 'N', code: 'KeyN' })).toBeUndefined();
        expect(key({ alt: true, key: '˜', code: 'KeyN' })).toBeUndefined();
        expect(key({ control: true, key: 'n', code: 'KeyN' })).toBeUndefined();
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

describe('isClearKey', () => {
    const press = { key: 'k', code: 'KeyK', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };

    it('finds ⌘K', () => {
        expect(isClearKey(press)).toBe(true);
        // A keyboard layout that is not QWERTY: the code tells the key.
        expect(isClearKey({ ...press, key: 'x' })).toBe(true);
    });

    it('ignores other keys and other modifiers', () => {
        expect(isClearKey({ ...press, key: 'j', code: 'KeyJ' })).toBe(false);
        expect(isClearKey({ ...press, metaKey: false })).toBe(false);
        expect(isClearKey({ ...press, ctrlKey: true })).toBe(false);
        expect(isClearKey({ ...press, altKey: true })).toBe(false);
        expect(isClearKey({ ...press, shiftKey: true })).toBe(false);
    });
});

describe('isCtrlV', () => {
    const press = { key: 'v', code: 'KeyV', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false };

    it('finds Ctrl+V', () => {
        expect(isCtrlV(press)).toBe(true);
        expect(isCtrlV({ ...press, key: 'x' })).toBe(true);
    });

    it('ignores ⌘V, other keys and other modifiers', () => {
        expect(isCtrlV({ ...press, ctrlKey: false, metaKey: true })).toBe(false);
        expect(isCtrlV({ ...press, key: 'c', code: 'KeyC' })).toBe(false);
        expect(isCtrlV({ ...press, metaKey: true })).toBe(false);
        expect(isCtrlV({ ...press, altKey: true })).toBe(false);
        expect(isCtrlV({ ...press, shiftKey: true })).toBe(false);
    });
});

describe('isImageOnlyPaste', () => {
    it('finds a paste with an image and no text', () => {
        expect(isImageOnlyPaste(['image/png'], '')).toBe(true);
        expect(isImageOnlyPaste(['Files'], '')).toBe(true);
    });

    it('ignores a paste with text', () => {
        expect(isImageOnlyPaste(['text/plain', 'image/png'], 'shot.png')).toBe(false);
        expect(isImageOnlyPaste(['text/plain'], 'hello')).toBe(false);
        expect(isImageOnlyPaste([], '')).toBe(false);
    });
});
