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

    it('puts an exact file name before scattered matches in longer names', () => {
        const rules = [
            'app/models/rules/conditional_exception_rule.rb',
            'app/models/rules/enru.rb',
            'app/models/rules/enru_helper.rb',
            'app/models/rules/green_rule.rb',
            'app/enru/config.rb'
        ];
        expect(fuzzyFilter(rules, 'enru').map((match) => match.path)).toEqual([
            'app/models/rules/enru.rb',
            'app/models/rules/enru_helper.rb',
            'app/models/rules/green_rule.rb',
            'app/enru/config.rb',
            'app/models/rules/conditional_exception_rule.rb'
        ]);
    });

    it('ranks the kinds of match from best to worst', () => {
        const ranked = [
            'lib/index.ts',
            'lib/index-page.ts',
            'lib/main-index.ts',
            'lib/index/config.ts',
            'lib/inline-dex.ts',
            'lib/i/n/d/e/x.ts'
        ];
        expect(fuzzyFilter([...ranked].reverse(), 'index').map((match) => match.path)).toEqual(ranked);
    });

    it('puts word starts and short names first', () => {
        expect(fuzzyFilter(['src/old-button.tsx', 'src/Button.tsx'], 'button')[0].path).toBe('src/Button.tsx');
        expect(fuzzyFilter(['src/abutton.ts', 'src/a-button.ts'], 'button')[0].path).toBe('src/a-button.ts');
        expect(fuzzyFilter(['src/FileExplorer.tsx', 'src/fixtures/large.tsx'], 'fe')[0].path).toBe(
            'src/FileExplorer.tsx'
        );
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
