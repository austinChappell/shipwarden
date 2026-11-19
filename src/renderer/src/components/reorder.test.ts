import { describe, expect, it } from 'vitest';
import { moveIndex, moveKeyTo, reorderKeyDelta } from './reorder';

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

describe('moveKeyTo', () => {
    const key = (item: string) => item;

    it('moves an item to a new index', () => {
        expect(moveKeyTo(['a', 'b', 'c', 'd'], key, 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
        expect(moveKeyTo(['a', 'b', 'c', 'd'], key, 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    });

    it('returns the same list when nothing moves', () => {
        const list = ['a', 'b'];
        expect(moveKeyTo(list, key, 'a', 0)).toBe(list);
        expect(moveKeyTo(list, key, 'x', 0)).toBe(list);
        expect(moveKeyTo(list, key, 'a', 5)).toBe(list);
    });

    it('moves an item only among the given keys, and the other items keep their index', () => {
        // The items "a", "c" and "e" are in one repository. "b" and "d" are in another one.
        expect(moveKeyTo(['a', 'b', 'c', 'd', 'e'], key, 'e', 0, ['a', 'c', 'e'])).toEqual(['e', 'b', 'a', 'd', 'c']);
        expect(moveKeyTo(['a', 'b', 'c', 'd', 'e'], key, 'a', 1, ['a', 'c', 'e'])).toEqual(['c', 'b', 'a', 'd', 'e']);
    });
});
