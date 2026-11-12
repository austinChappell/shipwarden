import { describe, expect, it } from 'vitest';
import { findText } from './selected-text';

describe('findText', () => {
    it('returns the text of a selection in one line', () => {
        expect(findText('const value')).toBe('const value');
    });

    it('keeps the spaces of the selection', () => {
        expect(findText('  return x; ')).toBe('  return x; ');
    });

    it('removes one line break at the end', () => {
        expect(findText('const value\n')).toBe('const value');
        expect(findText('const value\r\n')).toBe('const value');
    });

    it('returns undefined for a selection of more than one line', () => {
        expect(findText('one\ntwo')).toBeUndefined();
    });

    it('returns undefined for no selection', () => {
        expect(findText(undefined)).toBeUndefined();
        expect(findText('')).toBeUndefined();
        expect(findText('\n')).toBeUndefined();
    });
});
