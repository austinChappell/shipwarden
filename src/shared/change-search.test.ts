import { describe, expect, it } from 'vitest';
import { changePatch } from './change-search';
import { searchPatches } from './pr-search';

/** Searches local changes as the Changes tab does: the patch of each file, then the PR search. */
const searchChanges = (files: { key: string; original: string; modified: string }[], query: string, caseSensitive = false) =>
    searchPatches(files.map(file => ({ path: file.key, patch: changePatch(file.original, file.modified) })), query, caseSensitive);

const lines = (count: number, change?: { at: number; text: string }) =>
    Array.from({ length: count }, (_, index) => (change && index + 1 === change.at ? change.text : `line ${index + 1}`)).join('\n') + '\n';

describe('changePatch with searchPatches', () => {
    const original = lines(30, { at: 15, text: 'const old = Value;' });
    const modified = lines(30, { at: 15, text: 'const fresh = value;' });

    it('finds removed and added lines, and ignores case by default', () => {
        expect(searchChanges([{ key: 'a', original, modified }], 'value').map(match => [match.path, match.side, match.line])).toEqual([
            ['a', 'LEFT', 15],
            ['a', 'RIGHT', 15]
        ]);
    });

    it('can match case', () => {
        expect(searchChanges([{ key: 'a', original, modified }], 'Value', true).map(match => match.side)).toEqual(['LEFT']);
    });

    it('finds context lines near a change, but not the hidden lines far from it', () => {
        const found = searchChanges([{ key: 'a', original, modified }], 'line ').map(match => match.line);
        expect(found).toContain(14);
        expect(found).not.toContain(1);
        expect(found).not.toContain(30);
    });

    it('finds every line of a new file', () => {
        expect(searchChanges([{ key: 'new', original: '', modified: 'one\ntwo\n' }], 'o').map(match => match.line)).toEqual([1, 2]);
    });

    it('returns nothing for an empty text or equal versions', () => {
        expect(searchChanges([{ key: 'a', original, modified }], '')).toEqual([]);
        expect(searchChanges([{ key: 'a', original, modified: original }], 'line')).toEqual([]);
    });
});
