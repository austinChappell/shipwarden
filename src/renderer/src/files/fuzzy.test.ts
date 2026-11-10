import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyScore } from './fuzzy';

describe('fuzzyScore', () => {
    it('requires the query characters in order', () => {
        expect(fuzzyScore('src/main/index.ts', 'mit')).toBeDefined();
        expect(fuzzyScore('src/main/index.ts', 'xyz')).toBeUndefined();
        expect(fuzzyScore('abc', 'cba')).toBeUndefined();
    });

    it('ignores case and spaces', () => {
        expect(fuzzyScore('README.md', 'read me')).toBeDefined();
    });

    it('matches case when caseSensitive is true', () => {
        expect(fuzzyScore('README.md', 'READ', true)).toBeDefined();
        expect(fuzzyScore('README.md', 'read', true)).toBeUndefined();
    });
});

describe('fuzzyFilter', () => {
    const paths = [
        'src/main/files/file-service.ts',
        'src/main/files/file-service.test.ts',
        'docs/ARCHITECTURE.md',
        'src/renderer/src/components/FileExplorer.tsx',
        'package.json'
    ];

    it('puts file name matches before path matches', () => {
        expect(fuzzyFilter(paths, 'fileservice')[0].path).toBe('src/main/files/file-service.ts');
        expect(fuzzyFilter(paths, 'package')[0].path).toBe('package.json');
    });

    it('returns no results when nothing matches', () => {
        expect(fuzzyFilter(paths, 'zzz')).toEqual([]);
    });

    it('stops at the limit', () => {
        expect(fuzzyFilter(paths, 's', 2)).toHaveLength(2);
    });
});
