import { describe, expect, it } from 'vitest';
import { categoryInstructions, isCommentCategory, splitCategory, withCategory } from './comment-category';

describe('splitCategory', () => {
    it('reads a bold prefix', () => {
        expect(splitCategory('**Must fix:** The loop never ends.')).toEqual({ category: 'must-fix', text: 'The loop never ends.' });
    });

    it('reads a prefix with the colon after the bold text', () => {
        expect(splitCategory('**Nit**: Rename it.')).toEqual({ category: 'nit', text: 'Rename it.' });
    });

    it('reads a plain prefix and ignores case', () => {
        expect(splitCategory('nit: Rename it.')).toEqual({ category: 'nit', text: 'Rename it.' });
        expect(splitCategory('MUST-FIX: Stop.')).toEqual({ category: 'must-fix', text: 'Stop.' });
    });

    it('reads a prefix on its own line', () => {
        expect(splitCategory('**Concern:**\nThis can be slow.')).toEqual({ category: 'concern', text: 'This can be slow.' });
    });

    it('does not read a word that only starts like a category', () => {
        expect(splitCategory('nitpick: Rename it.')).toEqual({ text: 'nitpick: Rename it.' });
        expect(splitCategory('Nit:pick')).toEqual({ text: 'Nit:pick' });
        expect(splitCategory('**Nit: Rename it.')).toEqual({ text: '**Nit: Rename it.' });
    });

    it('does not read a category after the start', () => {
        expect(splitCategory('This is a nit: rename it.')).toEqual({ text: 'This is a nit: rename it.' });
    });
});

describe('withCategory', () => {
    it('adds a bold prefix', () => {
        expect(withCategory(' Rename it. ', 'nit')).toBe('**Nit:** Rename it.');
    });

    it('changes a prefix that is in the text', () => {
        expect(withCategory('**Nit:** Rename it.', 'must-fix')).toBe('**Must fix:** Rename it.');
    });

    it('does not change the text without a category', () => {
        expect(withCategory('Question: why?', undefined)).toBe('Question: why?');
    });

    it('gives the same category back after a split', () => {
        expect(splitCategory(withCategory('Why?', 'question'))).toEqual({ category: 'question', text: 'Why?' });
    });
});

describe('isCommentCategory', () => {
    it('accepts only the known categories', () => {
        expect(isCommentCategory('pattern')).toBe(true);
        expect(isCommentCategory('Must fix')).toBe(false);
        expect(isCommentCategory(undefined)).toBe(false);
    });
});

describe('categoryInstructions', () => {
    it('names each category value', () => {
        const text = categoryInstructions();
        for (const value of ['"must-fix"', '"concern"', '"pattern"', '"nit"', '"question"']) expect(text).toContain(value);
    });
});
