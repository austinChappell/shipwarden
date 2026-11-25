import { describe, expect, it } from 'vitest';
import { modalOpen, restoreFocus, wrapTarget } from './use-modal';

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

describe('restoreFocus', () => {
    const body = { contains: () => false } as unknown as Element;
    const inside = {} as Element;
    const outside = {} as Element;
    const dialog = { contains: (node: Element) => node === inside } as unknown as Element;

    it('restores the focus when no element has it', () => {
        expect(restoreFocus(null, body, dialog)).toBe(true);
        expect(restoreFocus(body, body, dialog)).toBe(true);
    });

    it('restores the focus when the dialog has it', () => {
        expect(restoreFocus(inside, body, dialog)).toBe(true);
    });

    it('keeps the focus on an element out of the dialog', () => {
        expect(restoreFocus(outside, body, dialog)).toBe(false);
        expect(restoreFocus(outside, body, null)).toBe(false);
    });
});
