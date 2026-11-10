/**
 * The cursor and the scroll position of each open file, so that a file opens again at the same place after a reload.
 * The key of the outer map is the worktree root. The key of the inner map is the path relative to the root.
 */
export interface EditorPosition {
    line: number;
    column: number;
    scrollTop: number;
    scrollLeft: number;
}

export type EditorPositions = Record<string, Record<string, EditorPosition>>;

const STORAGE_KEY = 'shipwarden.editorPositions';
/** The time in milliseconds after the last change before the positions go to local storage. */
const WRITE_DELAY = 500;

function isPosition(value: unknown): value is EditorPosition {
    if (!value || typeof value !== 'object') return false;
    const raw = value as Record<string, unknown>;
    const lineOk = Number.isInteger(raw.line) && (raw.line as number) >= 1;
    const columnOk = Number.isInteger(raw.column) && (raw.column as number) >= 1;
    const scrollOk = [raw.scrollTop, raw.scrollLeft].every(item => typeof item === 'number' && Number.isFinite(item) && item >= 0);
    return lineOk && columnOk && scrollOk;
}

/** Converts stored JSON to positions. Values with a wrong type are ignored. */
export function parsePositions(text: string | null): EditorPositions {
    if (!text) return {};
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return {};
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: EditorPositions = {};
    for (const [root, files] of Object.entries(value as Record<string, unknown>)) {
        if (!files || typeof files !== 'object' || Array.isArray(files)) continue;
        const kept: Record<string, EditorPosition> = {};
        for (const [path, position] of Object.entries(files as Record<string, unknown>)) {
            if (isPosition(position)) {
                const { line, column, scrollTop, scrollLeft } = position;
                kept[path] = { line, column, scrollTop, scrollLeft };
            }
        }
        if (Object.keys(kept).length > 0) result[root] = kept;
    }
    return result;
}

/**
 * Keeps only the positions of the files in `openFiles`, for each worktree in `roots`.
 * The positions of other worktrees do not change, because they can be in a different project.
 */
export function prunePositions(positions: EditorPositions, roots: readonly string[], openFiles: Readonly<Record<string, readonly string[]>>): EditorPositions {
    const result: EditorPositions = {};
    const pruned = new Set(roots);
    for (const [root, files] of Object.entries(positions)) {
        if (!pruned.has(root)) {
            result[root] = files;
            continue;
        }
        const open = new Set(openFiles[root] ?? []);
        const kept = Object.fromEntries(Object.entries(files).filter(([path]) => open.has(path)));
        if (Object.keys(kept).length > 0) result[root] = kept;
    }
    return result;
}

/** Returns the position in the range of a file with `lineCount` lines. */
export function clampPosition(position: EditorPosition, lineCount: number): EditorPosition {
    return { ...position, line: Math.max(1, Math.min(position.line, lineCount)) };
}

function read(): EditorPositions {
    try {
        return parsePositions(localStorage.getItem(STORAGE_KEY));
    } catch {
        return {};
    }
}

let positions: EditorPositions | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function current(): EditorPositions {
    positions ??= read();
    return positions;
}

function flush(): void {
    clearTimeout(timer);
    timer = undefined;
    if (!positions) return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
    } catch {
        // The positions stay for this session only.
    }
}

function scheduleWrite(): void {
    clearTimeout(timer);
    timer = setTimeout(flush, WRITE_DELAY);
}

if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', flush);
}

/** The store of the cursor and scroll positions of open files. It writes to local storage after a short delay. */
export const editorPositions = {
    get(root: string, path: string): EditorPosition | undefined {
        return current()[root]?.[path];
    },

    set(root: string, path: string, position: EditorPosition): void {
        const all = current();
        all[root] = { ...all[root], [path]: position };
        scheduleWrite();
    },

    /** Removes the position of one file, or of all files of the worktree when `path` is undefined. */
    forget(root: string, path?: string): void {
        const all = current();
        if (!all[root]) return;
        if (path === undefined) {
            delete all[root];
        } else {
            const { [path]: _removed, ...rest } = all[root];
            if (Object.keys(rest).length > 0) all[root] = rest;
            else delete all[root];
        }
        scheduleWrite();
    },

    /** Removes the positions of the files that are not open. See `prunePositions`. */
    prune(roots: readonly string[], openFiles: Readonly<Record<string, readonly string[]>>): void {
        positions = prunePositions(current(), roots, openFiles);
        scheduleWrite();
    }
};
