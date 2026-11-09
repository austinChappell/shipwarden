/** One visible row of the file tree, in the order of the tree. */
export interface TreeRow {
    path: string;
    isDirectory: boolean;
    /** True when the row is a folder and the folder is expanded. */
    open: boolean;
    /** The path of the folder that contains the row. The root is "". */
    parent: string;
}

/** The result of a key in the file tree. */
export type TreeAction =
    | { kind: 'move'; path: string }
    | { kind: 'expand'; path: string }
    | { kind: 'collapse'; path: string }
    | { kind: 'toggle'; path: string }
    | { kind: 'open'; path: string };

/**
 * Gives the action for a key in the file tree.
 * Up and Down move the cursor. Right expands a folder, or moves into an expanded folder.
 * Left collapses a folder, or moves to the parent folder. Enter opens a file or toggles a folder.
 * Returns undefined when the key has no action.
 */
export function treeKeyAction(rows: TreeRow[], cursor: string | undefined, key: string): TreeAction | undefined {
    if (rows.length === 0) {
        return undefined;
    }
    const index = rows.findIndex(row => row.path === cursor);
    const move = (target: number): TreeAction => ({ kind: 'move', path: rows[Math.max(0, Math.min(rows.length - 1, target))].path });
    if (index === -1) {
        // No cursor yet. The first key puts the cursor on a row.
        if (key === 'End') return move(rows.length - 1);
        return ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'Enter'].includes(key) ? move(0) : undefined;
    }
    const row = rows[index];
    switch (key) {
        case 'ArrowDown':
            return move(index + 1);
        case 'ArrowUp':
            return move(index - 1);
        case 'Home':
            return move(0);
        case 'End':
            return move(rows.length - 1);
        case 'ArrowRight':
            if (!row.isDirectory) return undefined;
            if (!row.open) return { kind: 'expand', path: row.path };
            // The first child is the next row. An empty or a loading folder has no next child row.
            return rows[index + 1]?.parent === row.path ? move(index + 1) : undefined;
        case 'ArrowLeft':
            if (row.isDirectory && row.open) return { kind: 'collapse', path: row.path };
            return row.parent ? { kind: 'move', path: row.parent } : undefined;
        case 'Enter':
            return { kind: row.isDirectory ? 'toggle' : 'open', path: row.path };
        default:
            return undefined;
    }
}
