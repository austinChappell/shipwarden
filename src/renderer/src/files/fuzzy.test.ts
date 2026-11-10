import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyPositions, fuzzyScore } from './fuzzy';

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

describe('fuzzyPositions', () => {
    it('prefers a match in one piece in the file name', () => {
        expect(fuzzyPositions('src/index/index.ts', 'index')).toEqual([10, 11, 12, 13, 14]);
    });

    it('finds a match in one piece in the folder path', () => {
        expect(fuzzyPositions('src/main/index.ts', 'main')).toEqual([4, 5, 6, 7]);
    });

    it('puts scattered matches as near the end as possible', () => {
        expect(fuzzyPositions('src/main/index.ts', 'mit')).toEqual([4, 9, 15]);
    });

    it('ignores case and spaces', () => {
        expect(fuzzyPositions('README.md', 'read me')).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('matches case when caseSensitive is true', () => {
        expect(fuzzyPositions('README.md', 'read', true)).toEqual([]);
        expect(fuzzyPositions('README.md', 'READ', true)).toEqual([0, 1, 2, 3]);
    });

    it('returns an empty list when the path does not match', () => {
        expect(fuzzyPositions('abc', 'cba')).toEqual([]);
        expect(fuzzyPositions('abc', '')).toEqual([]);
    });
});
