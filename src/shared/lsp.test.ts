import { describe, expect, it } from 'vitest';
import { exitReason, lastLines, lspLanguageId, rootForPath, sortChangesForLsp } from './lsp';

describe('lspLanguageId', () => {
    it.each([
        ['/r/src/a.ts', 'typescript'],
        ['/r/src/types.d.ts', 'typescript'],
        ['/r/src/App.tsx', 'typescriptreact'],
        ['/r/vite.config.mjs', 'javascript'],
        ['/r/src/main.rs', 'rust'],
        ['/r/app.py', 'python'],
        ['/r/main.go', 'go'],
        ['/r/app/models/user.rb', 'ruby'],
        ['/r/sorbet/rbi/gems/rack.rbi', 'ruby'],
        ['/r/lib/tasks/db.rake', 'ruby'],
        ['/r/Gemfile', 'ruby'],
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

describe('lastLines', () => {
    it('keeps the last lines and removes empty lines at the end', () => {
        expect(lastLines('a\nb\nc\nd\n\n', 2)).toBe('c\nd');
    });

    it('keeps the end of a long text', () => {
        expect(lastLines('abcdefghij', 10, 4)).toBe('…ghij');
    });

    it('changes CRLF to LF', () => {
        expect(lastLines('a\r\nb\r\n', 5)).toBe('a\nb');
    });
});

describe('exitReason', () => {
    it('gives the exit code, or the signal when no exit code exists', () => {
        expect(exitReason(1, null)).toBe('exit code 1');
        expect(exitReason(null, 'SIGKILL')).toBe('signal SIGKILL');
        expect(exitReason(null, null)).toBe('no exit code');
    });
});
