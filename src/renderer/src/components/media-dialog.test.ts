import { describe, expect, it } from 'vitest';
import { fitSize } from './MediaDialog';

describe('fitSize', () => {
    it('makes large media smaller and keeps the aspect ratio', () => {
        expect(fitSize(2000, 1000, { width: 1000, height: 1000 })).toEqual({ width: 1000, height: 500 });
        expect(fitSize(1000, 2000, { width: 1000, height: 1000 })).toEqual({ width: 500, height: 1000 });
    });

    it('does not make small media larger', () => {
        expect(fitSize(300, 200, { width: 1000, height: 1000 })).toEqual({ width: 300, height: 200 });
    });

    it('returns no size for media without a size', () => {
        expect(fitSize(0, 200, { width: 1000, height: 1000 })).toEqual({ width: 0, height: 0 });
    });
});
