import { describe, expect, it } from 'vitest';
import { normalizeScope, pickProvider, providerScopeSummary, type StoredReviewProvider } from './review-providers';

const provider = (id: string, kind: StoredReviewProvider['kind'], scope?: string[], enabled = true): StoredReviewProvider => ({
    id,
    kind,
    name: id,
    enabled,
    scope
});

describe('pickProvider', () => {
    it('selects the provider whose scope has the organization', () => {
        const list = [provider('all', 'github'), provider('work', 'github', ['Acme'])];
        expect(pickProvider(list, 'github', 'acme')?.id).toBe('work');
    });

    it('selects a provider with all organizations when no scope has the organization', () => {
        const list = [provider('work', 'github', ['acme']), provider('all', 'github')];
        expect(pickProvider(list, 'github', 'other')?.id).toBe('all');
    });

    it('selects the first provider of the kind when no scope matches', () => {
        const list = [provider('ado', 'azure'), provider('work', 'github', ['acme'])];
        expect(pickProvider(list, 'github', 'other')?.id).toBe('work');
    });

    it('ignores disabled providers and other kinds', () => {
        const list = [provider('off', 'github', ['acme'], false), provider('ado', 'azure', ['acme'])];
        expect(pickProvider(list, 'github', 'acme')).toBeUndefined();
    });
});

describe('normalizeScope', () => {
    it('removes empty and repeated names', () => {
        expect(normalizeScope([' acme ', '', 'ACME', 'other', 3])).toEqual(['acme', 'other']);
    });

    it('returns undefined for a value that is not a list', () => {
        expect(normalizeScope('acme')).toBeUndefined();
    });
});

describe('providerScopeSummary', () => {
    it('describes the scope', () => {
        expect(providerScopeSummary(undefined)).toBe('All organizations');
        expect(providerScopeSummary(['a'])).toBe('1 organization');
        expect(providerScopeSummary(['a', 'b'])).toBe('2 organizations');
    });
});
