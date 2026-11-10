import { describe, expect, it } from 'vitest';
import { hunkLines, searchPatches } from './pr-search';

const PATCH = [
    '@@ -10,4 +10,4 @@ function a() {',
    ' const keep = 1;',
    '-const old = Value;',
    '+const fresh = value;',
    ' return keep;',
    '\\ No newline at end of file'
].join('\n');

describe('hunkLines', () => {
    it('numbers the lines of each side', () => {
        expect(hunkLines(PATCH)).toEqual([
            { kind: 'context', left: 10, right: 10, text: 'const keep = 1;' },
            { kind: 'removed', left: 11, text: 'const old = Value;' },
            { kind: 'added', right: 11, text: 'const fresh = value;' },
            { kind: 'context', left: 12, right: 12, text: 'return keep;' }
        ]);
    });

    it('returns no lines without a patch', () => {
        expect(hunkLines(undefined)).toEqual([]);
    });
});

describe('searchPatches', () => {
    const files = [{ path: 'a.ts', patch: PATCH }, { path: 'big.bin' }];

    it('ignores case by default', () => {
        expect(searchPatches(files, 'value').map(match => [match.side, match.line])).toEqual([
            ['LEFT', 11],
            ['RIGHT', 11]
        ]);
    });

    it('can match case', () => {
        expect(searchPatches(files, 'Value', true).map(match => [match.side, match.line])).toEqual([['LEFT', 11]]);
    });

    it('puts a context line on the right side', () => {
        expect(searchPatches(files, 'keep')).toEqual([
            { path: 'a.ts', side: 'RIGHT', line: 10, text: 'const keep = 1;' },
            { path: 'a.ts', side: 'RIGHT', line: 12, text: 'return keep;' }
        ]);
    });

    it('returns nothing for an empty text', () => {
        expect(searchPatches(files, '')).toEqual([]);
    });
});
