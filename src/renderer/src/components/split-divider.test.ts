import { describe, expect, it } from 'vitest';
import { splitKeyRatio } from './SplitDivider';

describe('splitKeyRatio', () => {
    it('uses Left and Right in a row split, and Up and Down in a column split', () => {
        expect(splitKeyRatio(0.5, 'row', 'ArrowLeft', false)).toBeCloseTo(0.45);
        expect(splitKeyRatio(0.5, 'row', 'ArrowRight', false)).toBeCloseTo(0.55);
        expect(splitKeyRatio(0.5, 'row', 'ArrowUp', false)).toBeUndefined();
        expect(splitKeyRatio(0.5, 'column', 'ArrowUp', false)).toBeCloseTo(0.45);
        expect(splitKeyRatio(0.5, 'column', 'ArrowDown', false)).toBeCloseTo(0.55);
        expect(splitKeyRatio(0.5, 'column', 'ArrowRight', false)).toBeUndefined();
    });

    it('makes bigger steps with Shift', () => {
        expect(splitKeyRatio(0.5, 'row', 'ArrowRight', true)).toBeCloseTo(0.7);
    });

    it('keeps the ratio between 10% and 90%', () => {
        expect(splitKeyRatio(0.12, 'row', 'ArrowLeft', false)).toBe(0.1);
        expect(splitKeyRatio(0.8, 'column', 'ArrowDown', true)).toBe(0.9);
        expect(splitKeyRatio(0.5, 'row', 'Home', false)).toBe(0.1);
        expect(splitKeyRatio(0.5, 'row', 'End', false)).toBe(0.9);
    });

    it('ignores other keys', () => {
        expect(splitKeyRatio(0.5, 'row', 'Enter', false)).toBeUndefined();
    });
});
