import { describe, expect, it } from 'vitest';
import { isReviewStrictness, strictnessInstructions } from './review-strictness';
import { normalizeSettings, reviewStrictnessForRepo } from './settings';

describe('isReviewStrictness', () => {
    it('accepts only the three levels', () => {
        expect(isReviewStrictness('relaxed')).toBe(true);
        expect(isReviewStrictness('strict')).toBe(true);
        expect(isReviewStrictness('loose')).toBe(false);
        expect(isReviewStrictness(undefined)).toBe(false);
    });
});

describe('strictnessInstructions', () => {
    it('lets a relaxed review give no comments', () => {
        const text = strictnessInstructions('relaxed').join('\n');
        expect(text).toContain('Find only bugs and security problems');
        expect(text).toContain('An empty comment list is a good result.');
    });

    it('asks a strict review for small problems too', () => {
        expect(strictnessInstructions('strict').join('\n')).toContain('also for small problems');
    });

    it('puts the scope after the first line', () => {
        expect(strictnessInstructions('balanced', 'Look at X.')[1]).toBe('Look at X.');
    });
});

describe('review strictness settings', () => {
    it('is "balanced" by default and drops a wrong value', () => {
        expect(normalizeSettings({}).reviewStrictness).toBe('balanced');
        expect(normalizeSettings({ reviewStrictness: 'loose' }).reviewStrictness).toBe('balanced');
        expect(normalizeSettings({ reviewStrictness: 'strict' }).reviewStrictness).toBe('strict');
    });

    it('uses the value of the repository, else the global value', () => {
        const settings = normalizeSettings({
            reviewStrictness: 'strict',
            repos: { '/r/a': { reviewStrictness: 'relaxed' }, '/r/b': { reviewStrictness: 'nope' } }
        });
        expect(reviewStrictnessForRepo(settings, '/r/a')).toBe('relaxed');
        expect(reviewStrictnessForRepo(settings, '/r/b')).toBe('strict');
        expect(reviewStrictnessForRepo(settings, null)).toBe('strict');
    });
});
