/** A note: a file in the notes folder or in one of its folders, with its tags. */
export interface NoteInfo {
    /**
     * The path of the note in the notes folder, and its ID: the file name ("queries.sql"), or the folder and the file
     * name ("sql/queries.sql").
     */
    name: string;
    /** The file name, with any extension, for example "queries.sql". */
    fileName: string;
    /** The folder of the note. An empty text: the note is at the top level. */
    folder: string;
    tags: string[];
    size: number;
    createdAt: string;
    modifiedAt: string;
}

/** Notes larger than this are not opened in the editor. */
export const MAX_NOTE_BYTES = 5 * 1024 * 1024;
const MAX_NAME_LENGTH = 200;
const MAX_TAG_LENGTH = 40;

/**
 * Returns an error message when a note name is not a valid file name in the notes folder, else undefined.
 * A name has no folder part and does not start with a dot (the index file and hidden files start with a dot).
 */
export function noteNameError(name: string): string | undefined {
    const value = name.trim();
    if (!value) return 'Type a name, for example "scratch.md".';
    if (value.length > MAX_NAME_LENGTH) return `The name is too long. The maximum is ${MAX_NAME_LENGTH} characters.`;
    if (/[/\\\0:]/.test(value)) return 'The name cannot contain "/", "\\" or ":".';
    if (value.startsWith('.')) return 'The name cannot start with a dot.';
    return undefined;
}

/** Returns an error message when a folder name is not valid, else undefined. The rules are the same as for a note name. */
export function folderNameError(name: string): string | undefined {
    const value = name.trim();
    if (!value) return 'Type a folder name.';
    if (value.length > MAX_NAME_LENGTH) return `The name is too long. The maximum is ${MAX_NAME_LENGTH} characters.`;
    if (/[/\\\0:]/.test(value)) return 'The folder name cannot contain "/", "\\" or ":".';
    if (value.startsWith('.')) return 'The folder name cannot start with a dot.';
    return undefined;
}

/** The maximum depth of folders in the notes folder. */
export const MAX_FOLDER_DEPTH = 10;

/** Cleans a folder path: trims each part and removes empty parts. "a / b/" becomes "a/b". */
export function normalizeFolderPath(folder: string): string {
    return folder
        .split('/')
        .map(part => part.trim())
        .filter(Boolean)
        .join('/');
}

/** Splits a note path into its folder path (empty at the top level) and its file name. "a/b/c.md" has the folder "a/b". */
export function splitNotePath(notePath: string): { folder: string; fileName: string } {
    const value = notePath.trim();
    const slash = value.lastIndexOf('/');
    return slash < 0 ? { folder: '', fileName: value } : { folder: normalizeFolderPath(value.slice(0, slash)), fileName: value.slice(slash + 1).trim() };
}

/** Makes a note path from a folder path (empty for the top level) and a file name. */
export function joinNotePath(folder: string, fileName: string): string {
    const clean = normalizeFolderPath(folder);
    return clean ? `${clean}/${fileName.trim()}` : fileName.trim();
}

/** The parent of a folder path: "a/b" has the parent "a", and "a" has the parent "" (the top level). */
export function parentFolder(folder: string): string {
    const clean = normalizeFolderPath(folder);
    const slash = clean.lastIndexOf('/');
    return slash < 0 ? '' : clean.slice(0, slash);
}

/** The last part of a folder path: "a/b" has the name "b". */
export function folderBaseName(folder: string): string {
    const clean = normalizeFolderPath(folder);
    return clean.slice(clean.lastIndexOf('/') + 1);
}

/** True when `folder` is `ancestor` or is in it, at any depth. */
export function isInFolder(folder: string, ancestor: string): boolean {
    return folder === ancestor || folder.startsWith(`${ancestor}/`);
}

/** The folders that can get the folder `source`: all folders except `source` and the folders in it. */
export function folderMoveTargets(folders: readonly string[], source: string): string[] {
    return folders.filter(folder => !isInFolder(folder, source));
}

/** Returns an error message when a folder path ("a/b") is not valid, else undefined. Each part has the rules of a folder name. */
export function folderPathError(folder: string): string | undefined {
    const parts = folder.split('/').map(part => part.trim());
    if (parts.length > MAX_FOLDER_DEPTH) return `Folders can be ${MAX_FOLDER_DEPTH} levels deep at most.`;
    for (const part of parts) {
        const error = folderNameError(part);
        if (error) return error;
    }
    return undefined;
}

/** Returns an error message when a note path is not valid, else undefined. The folder part can have any depth up to the maximum. */
export function notePathError(notePath: string): string | undefined {
    const value = notePath.trim();
    if (value.includes('/')) {
        const error = folderPathError(value.slice(0, value.lastIndexOf('/')));
        if (error) return error;
    }
    return noteNameError(splitNotePath(value).fileName);
}

/** Cleans a list of tags: trims them, removes a leading "#", and removes empty tags and duplicates (ignoring case). */
export function normalizeTags(tags: unknown): string[] {
    if (!Array.isArray(tags)) return [];
    const result: string[] = [];
    for (const item of tags) {
        if (typeof item !== 'string') continue;
        const tag = item
            .trim()
            .replace(/^#+/, '')
            .replace(/[,\s]+/g, '-')
            .slice(0, MAX_TAG_LENGTH);
        if (tag && !result.some(other => other.toLowerCase() === tag.toLowerCase())) {
            result.push(tag);
        }
    }
    return result;
}

/** Returns a name that no note has, from a wanted name: "scratch.md", then "scratch-2.md", "scratch-3.md". */
export function uniqueNoteName(wanted: string, existing: string[]): string {
    const taken = new Set(existing.map(name => name.toLowerCase()));
    if (!taken.has(wanted.toLowerCase())) return wanted;
    const dot = wanted.lastIndexOf('.');
    const [base, extension] = dot > 0 ? [wanted.slice(0, dot), wanted.slice(dot)] : [wanted, ''];
    for (let index = 2; ; index++) {
        const candidate = `${base}-${index}${extension}`;
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
}

/** True when a note matches the search text (in its name or tags) and has all the selected tags. */
export function noteMatches(note: NoteInfo, query: string, tags: string[]): boolean {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const text = `${note.name} ${note.tags.map(tag => `#${tag}`).join(' ')}`.toLowerCase();
    const noteTags = note.tags.map(tag => tag.toLowerCase());
    return words.every(word => text.includes(word)) && tags.every(tag => noteTags.includes(tag.toLowerCase()));
}

/** The options of the tag picker: the matching tags that the note does not have, and "create" for a new tag. */
export function tagOptions(query: string, noteTags: string[], allTags: string[]): { tag: string; create: boolean }[] {
    const typed = normalizeTags([query])[0];
    const lower = query.trim().replace(/^#+/, '').toLowerCase();
    const has = (tag: string) => noteTags.some(item => item.toLowerCase() === tag.toLowerCase());
    const matches = allTags.filter(tag => !has(tag) && tag.toLowerCase().includes(lower)).map(tag => ({ tag, create: false }));
    const exists = typed && (has(typed) || allTags.some(tag => tag.toLowerCase() === typed.toLowerCase()));
    return typed && !exists ? [...matches, { tag: typed, create: true }] : matches;
}
