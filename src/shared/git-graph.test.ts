import { describe, expect, it } from 'vitest';
import { layoutGraph, parseGraphLog, parseGraphRefs, type GraphCommit } from './git-graph';

const commit = (hash: string, ...parents: string[]): GraphCommit => ({ hash, parents, author: 'A', date: 0, subject: hash, refs: [] });

describe('parseGraphRefs', () => {
    it('reads the current branch, local and remote branches and tags', () => {
        expect(parseGraphRefs('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.0')).toEqual([
            { name: 'main', kind: 'local', current: true },
            { name: 'origin/main', kind: 'remote' },
            { name: 'v1.0', kind: 'tag' }
        ]);
    });

    it('reads a detached HEAD', () => {
        expect(parseGraphRefs('HEAD, refs/heads/feature/a')).toEqual([{ name: 'HEAD', kind: 'head' }, { name: 'feature/a', kind: 'local' }]);
    });

    it('returns an empty list for an empty text', () => {
        expect(parseGraphRefs('')).toEqual([]);
    });
});

describe('parseGraphLog', () => {
    it('reads the records', () => {
        const record = (...fields: string[]) => `${fields.join('\x00')}\x1e\n`;
        const output = record('aaa', 'bbb ccc', 'Ann', '100', 'refs/heads/x', 'Merge it') + record('bbb', '', 'Bob', '2', '', 'First');
        expect(parseGraphLog(output)).toEqual([
            { hash: 'aaa', parents: ['bbb', 'ccc'], author: 'Ann', date: 100_000, subject: 'Merge it', refs: [{ name: 'x', kind: 'local' }] },
            { hash: 'bbb', parents: [], author: 'Bob', date: 2000, subject: 'First', refs: [] }
        ]);
    });
});

describe('layoutGraph', () => {
    it('keeps a straight history in one lane', () => {
        const layout = layoutGraph([commit('c', 'b'), commit('b', 'a'), commit('a')]);
        expect(layout.width).toBe(1);
        expect(layout.rows.map(row => row.lane)).toEqual([0, 0, 0]);
        // The last commit has no parent, so no line goes down from it.
        expect(layout.rows[2].lines).toEqual([{ fromLane: 0, fromY: 0, toLane: 0, toY: 0.5, color: 0 }]);
    });

    it('opens a second lane for a merge and closes it at the fork point', () => {
        // m merges f into the main line. f and b both come from a.
        const layout = layoutGraph([commit('m', 'b', 'f'), commit('f', 'a'), commit('b', 'a'), commit('a')]);
        expect(layout.width).toBe(2);
        expect(layout.rows.map(row => row.lane)).toEqual([0, 1, 0, 0]);
        expect(layout.rows[0].lines).toContainEqual({ fromLane: 0, fromY: 0.5, toLane: 1, toY: 1, color: 1 });
        // Both lanes wait for a, so the line of lane 1 bends into the dot of a in lane 0.
        expect(layout.rows[3].lines).toContainEqual({ fromLane: 1, fromY: 0, toLane: 0, toY: 0.5, color: 1 });
    });

    it('gives two branch tips their own lanes', () => {
        const layout = layoutGraph([commit('x', 'a'), commit('y', 'a'), commit('a')]);
        expect(layout.rows.map(row => row.lane)).toEqual([0, 1, 0]);
        // The line of x passes the row of y.
        expect(layout.rows[1].lines).toContainEqual({ fromLane: 0, fromY: 0, toLane: 0, toY: 1, color: 0 });
    });
});
