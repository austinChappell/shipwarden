import { describe, expect, it } from 'vitest';
import { clampPosition, parsePositions, prunePositions, type EditorPositions } from './editor-positions';

const at = (line: number) => ({ line, column: 3, scrollTop: 120, scrollLeft: 0 });

describe('parsePositions', () => {
    it('reads stored positions and ignores values with a wrong type', () => {
        const text = JSON.stringify({
            '/wt/a': { 'a.ts': at(4), 'b.ts': { line: 0, column: 1, scrollTop: 0, scrollLeft: 0 }, 'c.ts': { line: 2 } },
            '/wt/b': 'bad',
            '/wt/c': { 'x.ts': { ...at(9), extra: true } }
        });
        expect(parsePositions(text)).toEqual({ '/wt/a': { 'a.ts': at(4) }, '/wt/c': { 'x.ts': at(9) } });
    });

    it('returns no positions for missing or bad JSON', () => {
        expect(parsePositions(null)).toEqual({});
        expect(parsePositions('{bad')).toEqual({});
        expect(parsePositions('[1]')).toEqual({});
    });

    it('reads the JSON that it writes', () => {
        const positions: EditorPositions = { '/wt/a': { 'src/a.ts': at(10) } };
        expect(parsePositions(JSON.stringify(positions))).toEqual(positions);
    });
});

describe('prunePositions', () => {
    const positions: EditorPositions = {
        '/wt/a': { 'a.ts': at(1), 'closed.ts': at(2) },
        '/wt/b': { 'b.ts': at(3) },
        '/wt/other': { 'o.ts': at(4) }
    };

    it('keeps only the open files of the given worktrees', () => {
        expect(prunePositions(positions, ['/wt/a', '/wt/b'], { '/wt/a': ['a.ts'] })).toEqual({
            '/wt/a': { 'a.ts': at(1) },
            '/wt/other': { 'o.ts': at(4) }
        });
    });
});

describe('clampPosition', () => {
    it('moves a line after the end of the file to the last line', () => {
        expect(clampPosition(at(50), 20).line).toBe(20);
        expect(clampPosition(at(5), 20).line).toBe(5);
        expect(clampPosition(at(5), 0).line).toBe(1);
    });
});
