import { describe, expect, it } from 'vitest';
import { appKeyAction, isClearKey, isCommentKey, isCtrlV, isImageOnlyPaste, shortcutAction } from './shortcuts';

const key = (change: Partial<Parameters<typeof shortcutAction>[0]>) =>
    shortcutAction({ type: 'keyDown', meta: true, shift: false, control: false, alt: false, key: 'd', code: 'KeyD', ...change });

describe('shortcutAction', () => {
    it('finds the tab and split keys of Ghostty', () => {
        expect(key({})).toBe('right');
        expect(key({ shift: true, key: 'D' })).toBe('down');
        expect(key({ key: 't', code: 'KeyT' })).toBe('newTab');
        expect(key({ key: 'w', code: 'KeyW' })).toBe('close');
    });

    it('is ⌘[ for back and ⌘] for forward', () => {
        expect(key({ key: '[', code: 'BracketLeft' })).toBe('back');
        expect(key({ key: ']', code: 'BracketRight' })).toBe('forward');
    });

    it('is ⌥⌘ and an arrow key for the focus between panes', () => {
        expect(key({ alt: true, key: 'ArrowLeft', code: 'ArrowLeft' })).toBe('focusLeft');
        expect(key({ alt: true, key: 'ArrowRight', code: 'ArrowRight' })).toBe('focusRight');
        expect(key({ alt: true, key: 'ArrowUp', code: 'ArrowUp' })).toBe('focusUp');
        expect(key({ alt: true, key: 'ArrowDown', code: 'ArrowDown' })).toBe('focusDown');
        // ⌘ and an arrow key without Option move the cursor in a text field.
        expect(key({ key: 'ArrowLeft', code: 'ArrowLeft' })).toBeUndefined();
        expect(key({ alt: true, shift: true, key: 'ArrowLeft', code: 'ArrowLeft' })).toBeUndefined();
    });

    it('is ⇧⌘E for the focus in the file explorer, and ⌘E for the right panel', () => {
        expect(key({ shift: true, key: 'E', code: 'KeyE' })).toBe('focusExplorer');
        expect(key({ key: 'e', code: 'KeyE' })).toBe('toggleRightPanel');
    });

    it('ignores other keys, key up, and other modifiers', () => {
        expect(key({ type: 'keyUp' })).toBeUndefined();
        expect(key({ meta: false })).toBeUndefined();
        expect(key({ alt: true })).toBeUndefined();
        expect(key({ control: true })).toBeUndefined();
        expect(key({ key: 'k', code: 'KeyK' })).toBeUndefined();
        // ⇧⌘W closes the window, so it is not a workspace action.
        expect(key({ shift: true, key: 'W', code: 'KeyW' })).toBeUndefined();
        // ⇧⌘M opens the comment box of a diff. It is not a workspace action.
        expect(key({ shift: true, key: 'M', code: 'KeyM' })).toBeUndefined();
    });
});

describe('tab keys', () => {
    it('is ⌘1 to ⌘8 for a tab, and ⌘9 for the last tab', () => {
        for (let digit = 1; digit <= 8; digit++) {
            expect(key({ key: String(digit), code: `Digit${digit}` })).toBe(`selectTab${digit}`);
        }
        expect(key({ key: '9', code: 'Digit9' })).toBe('selectLastTab');
        // Without a code, the key tells the digit.
        expect(key({ key: '3', code: undefined })).toBe('selectTab3');
        // The digits of the number pad are not tab keys.
        expect(key({ key: '1', code: 'Numpad1' })).toBeUndefined();
    });

    it('leaves ⌘0 to the Actual Size menu item', () => {
        expect(key({ key: '0', code: 'Digit0' })).toBeUndefined();
    });

    it('is ⇧⌘[ for the previous tab and ⇧⌘] for the next tab', () => {
        expect(key({ shift: true, key: '{', code: 'BracketLeft' })).toBe('previousTab');
        expect(key({ shift: true, key: '}', code: 'BracketRight' })).toBe('nextTab');
        // A keyboard layout with the brackets on other keys: the character tells the key.
        expect(key({ shift: true, key: '{', code: 'Digit8' })).toBe('previousTab');
    });

    it('is ⌃Tab for the next tab and ⌃⇧Tab for the previous tab', () => {
        const tab = { meta: false, control: true, key: 'Tab', code: 'Tab' };
        expect(key(tab)).toBe('nextTab');
        expect(key({ ...tab, shift: true })).toBe('previousTab');
        expect(key({ ...tab, type: 'keyUp' })).toBeUndefined();
        // ⌃⌥Tab and ⌃⌘Tab are not tab keys.
        expect(key({ ...tab, alt: true })).toBeUndefined();
        expect(key({ ...tab, meta: true })).toBeUndefined();
        // Tab without Control moves the focus in the page.
        expect(key({ meta: false, key: 'Tab', code: 'Tab' })).toBeUndefined();
        expect(key({ key: 'Tab', code: 'Tab' })).toBeUndefined();
    });

    it('ignores the digit keys with other modifiers', () => {
        // ⇧⌘1 sends "!". ⌃⌘1 is not a tab key.
        expect(key({ shift: true, key: '!', code: 'Digit1' })).toBeUndefined();
        expect(key({ control: true, key: '1', code: 'Digit1' })).toBeUndefined();
        expect(key({ meta: false, key: '1', code: 'Digit1' })).toBeUndefined();
    });
});

describe('view keys', () => {
    it('is ⌥⌘1 to ⌥⌘6 for the views, from the code of the key', () => {
        // With Option, macOS sends another character in "key" (for example "¡" for 1). The code stays "Digit1".
        expect(key({ alt: true, key: '¡', code: 'Digit1' })).toBe('viewDashboard');
        expect(key({ alt: true, key: '™', code: 'Digit2' })).toBe('viewAgents');
        expect(key({ alt: true, key: '£', code: 'Digit3' })).toBe('viewTasks');
        expect(key({ alt: true, key: '¢', code: 'Digit4' })).toBe('viewReview');
        expect(key({ alt: true, key: '∞', code: 'Digit5' })).toBe('viewPipelines');
        expect(key({ alt: true, key: '§', code: 'Digit6' })).toBe('viewNotes');
    });

    it('ignores ⌥⌘7, Shift, Control and a key without a code', () => {
        expect(key({ alt: true, key: '¶', code: 'Digit7' })).toBeUndefined();
        expect(key({ alt: true, shift: true, key: '⁄', code: 'Digit1' })).toBeUndefined();
        expect(key({ alt: true, control: true, key: '1', code: 'Digit1' })).toBeUndefined();
        expect(key({ alt: true, key: '1', code: undefined })).toBeUndefined();
    });
});

describe('focusWorkspace', () => {
    it('is ⇧⌘0, from the code of the key', () => {
        expect(key({ shift: true, key: ')', code: 'Digit0' })).toBe('focusWorkspace');
        expect(key({ shift: true, alt: true, key: '‚', code: 'Digit0' })).toBeUndefined();
        expect(key({ shift: true, control: true, key: ')', code: 'Digit0' })).toBeUndefined();
    });
});

describe('isCommentKey', () => {
    const press = { key: 'M', code: 'KeyM', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true };

    it('finds ⇧⌘M', () => {
        expect(isCommentKey(press)).toBe(true);
        expect(isCommentKey({ ...press, key: 'x' })).toBe(true);
    });

    it('ignores ⌘M, other keys and other modifiers', () => {
        expect(isCommentKey({ ...press, shiftKey: false, key: 'm' })).toBe(false);
        expect(isCommentKey({ ...press, key: 'N', code: 'KeyN' })).toBe(false);
        expect(isCommentKey({ ...press, metaKey: false })).toBe(false);
        expect(isCommentKey({ ...press, ctrlKey: true })).toBe(false);
        expect(isCommentKey({ ...press, altKey: true, key: 'Â' })).toBe(false);
    });
});

describe('toggleSidebar', () => {
    it('is ⌘B, and ⇧⌘B moves the focus to the sidebar', () => {
        expect(shortcutAction({ type: 'keyDown', meta: true, shift: false, control: false, alt: false, key: 'b', code: 'KeyB' })).toBe('toggleSidebar');
        expect(shortcutAction({ type: 'keyDown', meta: true, shift: true, control: false, alt: false, key: 'B', code: 'KeyB' })).toBe('focusSidebar');
    });

    it('is not ⌥⌘B, and other ⌥⌘ keys are not shortcuts', () => {
        // With Option, macOS sends another character in "key" (for example "∫"). The code stays "KeyB".
        expect(shortcutAction({ type: 'keyDown', meta: true, shift: false, control: false, alt: true, key: '∫', code: 'KeyB' })).toBeUndefined();
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
    const key = (code: string, mods: Partial<{ meta: boolean; shift: boolean; alt: boolean; control: boolean }> = {}) => ({
        type: 'keyDown',
        meta: true,
        shift: false,
        alt: false,
        control: false,
        key: code.replace('Key', '').toLowerCase(),
        code,
        ...mods
    });

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
