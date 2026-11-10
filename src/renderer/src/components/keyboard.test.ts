import { describe, expect, it } from 'vitest';
import { stepIndex } from './keyboard';

describe('stepIndex', () => {
    it('moves forward and backward', () => {
        expect(stepIndex(0, 3, 1)).toBe(1);
        expect(stepIndex(2, 3, -1)).toBe(1);
    });

    it('wraps at the two ends', () => {
        expect(stepIndex(2, 3, 1)).toBe(0);
        expect(stepIndex(0, 3, -1)).toBe(2);
    });

    it('returns -1 for an empty list', () => {
        expect(stepIndex(0, 0, 1)).toBe(-1);
    });
});
