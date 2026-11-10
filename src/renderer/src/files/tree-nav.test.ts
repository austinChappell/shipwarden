import { describe, expect, it } from 'vitest';
import { treeKeyAction, type TreeRow } from './tree-nav';

// src/ (open)
//   main.ts
//   lib/ (closed)
// README.md
const rows: TreeRow[] = [
    { path: 'src', isDirectory: true, open: true, parent: '' },
    { path: 'src/main.ts', isDirectory: false, open: false, parent: 'src' },
    { path: 'src/lib', isDirectory: true, open: false, parent: 'src' },
    { path: 'README.md', isDirectory: false, open: false, parent: '' }
];

describe('treeKeyAction', () => {
    it('moves up and down and stops at the ends', () => {
        expect(treeKeyAction(rows, 'src', 'ArrowDown')).toEqual({ kind: 'move', path: 'src/main.ts' });
        expect(treeKeyAction(rows, 'src/main.ts', 'ArrowUp')).toEqual({ kind: 'move', path: 'src' });
        expect(treeKeyAction(rows, 'README.md', 'ArrowDown')).toEqual({ kind: 'move', path: 'README.md' });
        expect(treeKeyAction(rows, 'src', 'ArrowUp')).toEqual({ kind: 'move', path: 'src' });
        expect(treeKeyAction(rows, 'src/main.ts', 'End')).toEqual({ kind: 'move', path: 'README.md' });
        expect(treeKeyAction(rows, 'README.md', 'Home')).toEqual({ kind: 'move', path: 'src' });
    });

    it('puts the cursor on the first row when there is no cursor', () => {
        expect(treeKeyAction(rows, undefined, 'ArrowDown')).toEqual({ kind: 'move', path: 'src' });
        expect(treeKeyAction(rows, 'gone.ts', 'Enter')).toEqual({ kind: 'move', path: 'src' });
        expect(treeKeyAction(rows, undefined, 'a')).toBeUndefined();
        expect(treeKeyAction([], undefined, 'ArrowDown')).toBeUndefined();
    });

    it('expands a closed folder with Right, then moves into it', () => {
        expect(treeKeyAction(rows, 'src/lib', 'ArrowRight')).toEqual({ kind: 'expand', path: 'src/lib' });
        expect(treeKeyAction(rows, 'src', 'ArrowRight')).toEqual({ kind: 'move', path: 'src/main.ts' });
        expect(treeKeyAction(rows, 'src/main.ts', 'ArrowRight')).toBeUndefined();
    });

    it('does not move out of an open folder with no child rows', () => {
        const empty: TreeRow[] = [
            { path: 'a', isDirectory: true, open: true, parent: '' },
            { path: 'b', isDirectory: false, open: false, parent: '' }
        ];
        expect(treeKeyAction(empty, 'a', 'ArrowRight')).toBeUndefined();
    });

    it('collapses an open folder with Left, or else moves to the parent', () => {
        expect(treeKeyAction(rows, 'src', 'ArrowLeft')).toEqual({ kind: 'collapse', path: 'src' });
        expect(treeKeyAction(rows, 'src/lib', 'ArrowLeft')).toEqual({ kind: 'move', path: 'src' });
        expect(treeKeyAction(rows, 'src/main.ts', 'ArrowLeft')).toEqual({ kind: 'move', path: 'src' });
        expect(treeKeyAction(rows, 'README.md', 'ArrowLeft')).toBeUndefined();
    });

    it('opens a file and toggles a folder with Enter', () => {
        expect(treeKeyAction(rows, 'src/main.ts', 'Enter')).toEqual({ kind: 'open', path: 'src/main.ts' });
        expect(treeKeyAction(rows, 'src/lib', 'Enter')).toEqual({ kind: 'toggle', path: 'src/lib' });
    });
});
