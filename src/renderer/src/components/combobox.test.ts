import { describe, expect, it } from 'vitest';
import { sortedGroups } from './Combobox';

describe('sortedGroups', () => {
    it('sorts the groups and the items in each group in alphabetical order', () => {
        const repos = [
            { owner: 'globex', name: 'web' },
            { owner: 'Acme', name: 'zeta' },
            { owner: 'globex', name: 'API' },
            { owner: 'globex', name: 'app10' },
            { owner: 'globex', name: 'app9' },
            { owner: 'Acme', name: 'alpha' }
        ];
        const groups = sortedGroups(repos, repo => repo.owner, repo => ({ value: `${repo.owner}/${repo.name}`, label: repo.name }));
        expect(groups.map(group => [group.label, group.items.map(item => item.label)])).toEqual([
            ['Acme', ['alpha', 'zeta']],
            ['globex', ['API', 'app9', 'app10', 'web']]
        ]);
    });

    it('puts the items without a group first', () => {
        const groups = sortedGroups([{ path: 'b' }, { path: '' }], item => item.path, item => ({ value: item.path, label: item.path || 'none' }));
        expect(groups.map(group => group.label)).toEqual(['', 'b']);
    });
});
