import { describe, expect, it } from 'vitest';
import { readFlag } from './stored-flag';

describe('readFlag', () => {
    it('reads the stored value', () => {
        expect(readFlag('true', false)).toBe(true);
        expect(readFlag('false', true)).toBe(false);
    });

    it('gives the fallback for a missing value', () => {
        expect(readFlag(null, true)).toBe(true);
        expect(readFlag(null, false)).toBe(false);
    });

    it('gives the fallback for a wrong value', () => {
        expect(readFlag('yes', true)).toBe(true);
        expect(readFlag('yes', false)).toBe(false);
    });
});
