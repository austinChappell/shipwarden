import { describe, expect, it } from 'vitest';
import { navTargetIndex } from './list-nav';

describe('navTargetIndex', () => {
    it('moves down and up', () => {
        expect(navTargetIndex('ArrowDown', 0, 3)).toBe(1);
        expect(navTargetIndex('ArrowUp', 2, 3)).toBe(1);
    });

    it('stops at the ends of the list', () => {
        expect(navTargetIndex('ArrowDown', 2, 3)).toBeUndefined();
        expect(navTargetIndex('ArrowUp', 0, 3)).toBeUndefined();
    });

    it('moves to the first and the last item', () => {
        expect(navTargetIndex('Home', 2, 3)).toBe(0);
        expect(navTargetIndex('End', 0, 3)).toBe(2);
    });

    it('ignores other keys and empty lists', () => {
        expect(navTargetIndex('ArrowLeft', 1, 3)).toBeUndefined();
        expect(navTargetIndex('Enter', 1, 3)).toBeUndefined();
        expect(navTargetIndex('ArrowDown', 0, 0)).toBeUndefined();
    });
});
