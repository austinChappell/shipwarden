import { describe, expect, it } from 'vitest';
import { clampWidth, resizeKeyWidth } from './ResizeHandle';

describe('clampWidth', () => {
    it('keeps a width between the smallest and the largest width', () => {
        expect(clampWidth(100, 220, 720)).toBe(220);
        expect(clampWidth(900, 220, 720)).toBe(720);
        expect(clampWidth(300, 220, 720)).toBe(300);
    });

    it('rounds the width to a full pixel', () => {
        expect(clampWidth(300.6, 220, 720)).toBe(301);
    });
});

describe('resizeKeyWidth', () => {
    it('makes a panel with the handle on its left side wider with Left', () => {
        expect(resizeKeyWidth(300, 720, 'left', 'ArrowLeft', false)).toBe(316);
        expect(resizeKeyWidth(300, 720, 'left', 'ArrowRight', false)).toBe(284);
    });

    it('makes a panel with the handle on its right side wider with Right', () => {
        expect(resizeKeyWidth(300, 720, 'right', 'ArrowRight', false)).toBe(316);
        expect(resizeKeyWidth(300, 720, 'right', 'ArrowLeft', false)).toBe(284);
    });

    it('makes bigger steps with Shift', () => {
        expect(resizeKeyWidth(300, 720, 'right', 'ArrowRight', true)).toBe(364);
    });

    it('goes to the largest width with End', () => {
        expect(resizeKeyWidth(300, 720, 'left', 'End', false)).toBe(720);
    });

    it('ignores other keys', () => {
        expect(resizeKeyWidth(300, 720, 'left', 'ArrowUp', false)).toBeUndefined();
        expect(resizeKeyWidth(300, 720, 'left', 'Enter', false)).toBeUndefined();
        expect(resizeKeyWidth(300, 720, 'left', 'Home', false)).toBeUndefined();
    });
});
