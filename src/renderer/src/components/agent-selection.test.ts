import { describe, expect, it } from 'vitest';
import { clickSelection, toggleAll } from './agent-selection';

const order = ['a', 'b', 'c', 'd', 'e'];
const sorted = (set: Set<string>) => [...set].sort();

describe('clickSelection', () => {
    it('toggles one item without Shift', () => {
        expect(sorted(clickSelection(new Set(), order, 'b', 'a', false))).toEqual(['b']);
        expect(sorted(clickSelection(new Set(['b']), order, 'b', 'a', false))).toEqual([]);
    });

    it('selects the range from the anchor with Shift', () => {
        expect(sorted(clickSelection(new Set(['b']), order, 'd', 'b', true))).toEqual(['b', 'c', 'd']);
        expect(sorted(clickSelection(new Set(['d']), order, 'b', 'd', true))).toEqual(['b', 'c', 'd']);
    });

    it('clears the range when the clicked item is selected', () => {
        expect(sorted(clickSelection(new Set(['a', 'b', 'c', 'd']), order, 'c', 'a', true))).toEqual(['d']);
    });

    it('toggles one item when the anchor is not in the list', () => {
        expect(sorted(clickSelection(new Set(), order, 'c', undefined, true))).toEqual(['c']);
        expect(sorted(clickSelection(new Set(), order, 'c', 'gone', true))).toEqual(['c']);
    });
});

describe('toggleAll', () => {
    it('selects all when one or more are not selected', () => {
        expect(sorted(toggleAll(new Set(['a', 'x']), ['a', 'b']))).toEqual(['a', 'b', 'x']);
    });

    it('clears all when all are selected', () => {
        expect(sorted(toggleAll(new Set(['a', 'b', 'x']), ['a', 'b']))).toEqual(['x']);
    });
});
