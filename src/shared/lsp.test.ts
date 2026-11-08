import { describe, expect, it } from 'vitest';
import { lspLanguageId, rootForPath, sortChangesForLsp } from './lsp';

describe('lspLanguageId', () => {
    it.each([
        ['/r/src/a.ts', 'typescript'],
        ['/r/src/types.d.ts', 'typescript'],
        ['/r/src/App.tsx', 'typescriptreact'],
        ['/r/vite.config.mjs', 'javascript'],
        ['/r/src/main.rs', 'rust'],
        ['/r/app.py', 'python'],
        ['/r/main.go', 'go'],
        ['/r/README.md', undefined],
        ['/r/.gitignore', undefined],
        ['/r/Makefile', undefined]
    ])('maps %p to %p', (path, id) => {
        expect(lspLanguageId(path)).toBe(id);
    });
});

describe('rootForPath', () => {
    const roots = ['/repo', '/home/me/.shipwarden/worktrees/repo/feature', '/repo/nested'];

    it('finds the root that contains the path', () => {
        expect(rootForPath(roots, '/home/me/.shipwarden/worktrees/repo/feature/src/a.ts')).toBe('/home/me/.shipwarden/worktrees/repo/feature');
    });

    it('prefers the longest root', () => {
        expect(rootForPath(roots, '/repo/nested/x.ts')).toBe('/repo/nested');
        expect(rootForPath(roots, '/repo/src/x.ts')).toBe('/repo');
    });

    it('does not match a root that is only a prefix of a folder name', () => {
        expect(rootForPath(['/repo'], '/repository/x.ts')).toBeUndefined();
    });
});

describe('sortChangesForLsp', () => {
    it('puts the change with the largest offset first', () => {
        const changes = [{ rangeOffset: 5 }, { rangeOffset: 40 }, { rangeOffset: 12 }];
        expect(sortChangesForLsp(changes).map(change => change.rangeOffset)).toEqual([40, 12, 5]);
    });
});
