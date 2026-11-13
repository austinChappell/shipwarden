import { describe, expect, it } from 'vitest';
import { repoGroups } from './repo-choices';

describe('repoGroups', () => {
    it('puts the repositories of each organization in alphabetical order', () => {
        const groups = repoGroups([
            { owner: 'zeta', name: 'web', pushedAt: '2026-11-12T00:00:00Z' },
            { owner: 'acme', name: 'worker', pushedAt: '2026-11-13T00:00:00Z' },
            { owner: 'acme', name: 'API', pushedAt: '2026-11-01T00:00:00Z' },
            { owner: 'acme', name: 'billing' }
        ]);
        expect(groups.map(group => group.label)).toEqual(['acme', 'zeta']);
        expect(groups[0].items.map(item => item.label)).toEqual(['API', 'billing', 'worker']);
        expect(groups[0].items[0].value).toBe('acme/API');
    });
});
