import { describe, expect, it } from 'vitest';
import { browserViewKey, isAppKeyAction, type KeyInput } from './keys';

/** Returns a key down event with the Command key. */
function key(value: string, change: Partial<KeyInput> = {}): KeyInput {
    return { type: 'keyDown', meta: true, shift: false, control: false, alt: false, key: value, ...change };
}

describe('browserViewKey', () => {
    it('finds the keys of a browser view', () => {
        expect(browserViewKey(key('r'))).toBe('reload');
        expect(browserViewKey(key('l'))).toBe('focusAddress');
        expect(browserViewKey(key('i', { alt: true }))).toBe('devTools');
    });
    it('reads the physical key from the code', () => {
        // With ⌥, macOS gives a different character in "key". The code stays "KeyI".
        expect(browserViewKey(key('ˆ', { alt: true, code: 'KeyI' }))).toBe('devTools');
        expect(browserViewKey(key('R', { code: 'KeyR' }))).toBe('reload');
    });
    it('ignores the keys with other modifiers', () => {
        expect(browserViewKey(key('r', { shift: true }))).toBeUndefined();
        expect(browserViewKey(key('r', { alt: true }))).toBeUndefined();
        expect(browserViewKey(key('l', { control: true }))).toBeUndefined();
        expect(browserViewKey(key('i'))).toBeUndefined();
        expect(browserViewKey(key('i', { alt: true, shift: true }))).toBeUndefined();
    });
    it('ignores a key without Command and a key up event', () => {
        expect(browserViewKey(key('r', { meta: false }))).toBeUndefined();
        expect(browserViewKey(key('r', { type: 'keyUp' }))).toBeUndefined();
    });
    it('ignores other keys', () => {
        expect(browserViewKey(key('t'))).toBeUndefined();
    });
});

describe('isAppKeyAction', () => {
    it('accepts the four app key actions', () => {
        expect(['quit', 'quitAndStop', 'settings', 'hide'].every(isAppKeyAction)).toBe(true);
    });
    it('rejects other values', () => {
        expect(isAppKeyAction('close')).toBe(false);
        expect(isAppKeyAction(undefined)).toBe(false);
        expect(isAppKeyAction({ action: 'quit' })).toBe(false);
    });
});
