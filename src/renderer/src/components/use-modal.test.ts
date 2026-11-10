import { describe, expect, it } from 'vitest';
import { modalOpen, wrapTarget } from './use-modal';

describe('wrapTarget', () => {
    const items = ['a', 'b', 'c'];

    it('lets the browser move the focus in the middle of the list', () => {
        expect(wrapTarget(items, 'a', false)).toBeUndefined();
        expect(wrapTarget(items, 'b', true)).toBeUndefined();
    });

    it('wraps from the last item to the first item, and back', () => {
        expect(wrapTarget(items, 'c', false)).toBe('a');
        expect(wrapTarget(items, 'a', true)).toBe('c');
    });

    it('starts at an end when the focus is not on an item', () => {
        expect(wrapTarget(items, null, false)).toBe('a');
        expect(wrapTarget(items, 'x', true)).toBe('c');
    });

    it('returns undefined for an empty list', () => {
        expect(wrapTarget([], null, false)).toBeUndefined();
    });
});

describe('modalOpen', () => {
    it('is false when no modal shows', () => {
        expect(modalOpen()).toBe(false);
    });
});
