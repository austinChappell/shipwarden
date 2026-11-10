import { describe, expect, it } from 'vitest';
import { moveIndex, reorderKeyDelta } from './reorder';

describe('moveIndex', () => {
    const keys = ['a', 'b', 'c'];

    it('moves a key up or down one place', () => {
        expect(moveIndex(keys, 'b', -1)).toBe(0);
        expect(moveIndex(keys, 'b', 1)).toBe(2);
    });

    it('does not move a key past an end of the list', () => {
        expect(moveIndex(keys, 'a', -1)).toBeUndefined();
        expect(moveIndex(keys, 'c', 1)).toBeUndefined();
    });

    it('does not move a key that is not in the list', () => {
        expect(moveIndex(keys, 'x', 1)).toBeUndefined();
    });
});

describe('reorderKeyDelta', () => {
    const delta = (key: string, mods: Partial<{ altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) =>
        reorderKeyDelta({ key, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...mods });

    it('reads Alt+Up and Alt+Down', () => {
        expect(delta('ArrowUp', { altKey: true })).toBe(-1);
        expect(delta('ArrowDown', { altKey: true })).toBe(1);
    });

    it('ignores the arrow keys without Alt or with other modifiers', () => {
        expect(delta('ArrowUp')).toBeUndefined();
        expect(delta('ArrowDown', { altKey: true, shiftKey: true })).toBeUndefined();
        expect(delta('ArrowDown', { altKey: true, metaKey: true })).toBeUndefined();
        expect(delta('Enter', { altKey: true })).toBeUndefined();
    });
});
