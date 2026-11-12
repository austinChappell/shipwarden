/** One entry of a folder in the file explorer. */
export interface FileEntry {
    name: string;
    /** The path relative to the worktree root, with "/" as the separator. */
    path: string;
    isDirectory: boolean;
    /** True when git ignores the entry, for example `node_modules`. */
    ignored: boolean;
}

/** One line that matches a content search. */
export interface ContentMatch {
    /** The path relative to the worktree root. */
    path: string;
    /** The line number. The first line is 1. */
    line: number;
    text: string;
}

export interface ContentSearchResult {
    matches: ContentMatch[];
    /** True when the search found more matches than the limit. */
    truncated: boolean;
}

/** An event that tells the UI that files changed in a worktree. */
export interface FilesChangedEvent {
    root: string;
    /** The folders that changed, relative to the root. An empty string is the root. */
    directories: string[];
}

/** Sorts entries like Orca: folders first, then by name. The comparison ignores case. Dot files sort first. */
export function compareEntries(a: FileEntry, b: FileEntry): number {
    if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
    }
    const nameA = a.name.toLowerCase();
    const nameB = b.name.toLowerCase();
    return nameA < nameB ? -1 : nameA > nameB ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Returns the folder part of a relative path. Returns an empty string for a file at the root. */
export function parentPath(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash === -1 ? '' : path.slice(0, slash);
}

/** Returns the last part of a path. */
export function baseName(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

/** The characters of a line that show before the first match. A longer start is cut, so the match stays in view. */
const CONTEXT_BEFORE = 16;

/** Trims a line of a content match, and cuts a long start so that the first match shows. */
export function matchLine(text: string, query: string, caseSensitive = false): string {
    const line = text.trim();
    const index = !query ? -1 : caseSensitive ? line.indexOf(query) : line.toLowerCase().indexOf(query.toLowerCase());
    if (index <= CONTEXT_BEFORE + 8) return line;
    return `…${line.slice(index - CONTEXT_BEFORE).trimStart()}`;
}

/** Joins a folder and a name to a relative path. An empty folder is the root. */
export function joinPath(directory: string, name: string): string {
    return directory ? `${directory}/${name}` : name;
}

/**
 * Checks a name of a new or renamed file or folder. Returns the error text, or undefined when the name is valid.
 * A name with "/" makes subfolders when `allowFolders` is true.
 */
export function fileNameError(name: string, allowFolders = false): string | undefined {
    if (!name.trim()) {
        return 'Type a name.';
    }
    if (name.includes('\0')) {
        return 'The name contains a character that is not permitted.';
    }
    if (!allowFolders && name.includes('/')) {
        return 'The name must not contain "/".';
    }
    for (const part of name.split('/')) {
        if (part === '' || part === '.' || part === '..') {
            return `The name "${name}" is not valid.`;
        }
        if (part === '.git') {
            return 'ShipWarden does not change the .git folder.';
        }
    }
    return undefined;
}

/** True when `path` is the folder `folder` or is in it. Both paths are relative to the root. */
export function isSameOrInside(folder: string, path: string): boolean {
    return folder === '' || path === folder || path.startsWith(`${folder}/`);
}

/**
 * Returns a name that is not in `taken`, as the Finder does: "name copy.ext", then "name copy 2.ext".
 * Returns the name itself when it is free.
 */
export function freeName(name: string, taken: ReadonlySet<string>): string {
    if (!taken.has(name)) {
        return name;
    }
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    for (let index = 1; ; index += 1) {
        const candidate = `${stem} copy${index === 1 ? '' : ` ${index}`}${extension}`;
        if (!taken.has(candidate)) {
            return candidate;
        }
    }
}
