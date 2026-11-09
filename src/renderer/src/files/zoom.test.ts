import { describe, expect, it } from 'vitest';
import { clampZoom, fitZoom, MAX_ZOOM, MIN_ZOOM, stepZoom } from './zoom';

describe('stepZoom', () => {
    it('goes to the next step', () => {
        expect(stepZoom(1, 1)).toBe(1.25);
        expect(stepZoom(1, -1)).toBe(0.75);
        expect(stepZoom(0.8, 1)).toBe(1);
        expect(stepZoom(0.8, -1)).toBe(0.75);
    });

    it('stops at the limits', () => {
        expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
        expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    });
});

describe('fitZoom', () => {
    it('makes a large image small enough for the box', () => {
        expect(fitZoom(2000, 1000, 1000, 1000)).toBe(0.5);
        expect(fitZoom(1000, 2000, 1000, 500)).toBe(0.25);
    });

    it('keeps a small image at its size', () => {
        expect(fitZoom(100, 100, 1000, 1000)).toBe(1);
    });

    it('returns 1 when a size is not known', () => {
        expect(fitZoom(0, 0, 1000, 1000)).toBe(1);
        expect(fitZoom(100, 100, 0, 0)).toBe(1);
    });
});

describe('clampZoom', () => {
    it('keeps the zoom between the limits', () => {
        expect(clampZoom(100)).toBe(MAX_ZOOM);
        expect(clampZoom(0)).toBe(MIN_ZOOM);
        expect(clampZoom(2)).toBe(2);
    });
});
