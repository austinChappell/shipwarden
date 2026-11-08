import { promises as fs, watch, type FSWatcher } from 'fs';
import * as path from 'path';
import { folderPathError, joinNotePath, MAX_FOLDER_DEPTH, MAX_NOTE_BYTES, normalizeFolderPath, normalizeTags, notePathError, splitNotePath, type NoteInfo } from '@shared/notes';
import { JsonStore } from '../tasks/json-store';

/** The file in the notes folder that keeps the tags. It starts with a dot, so it is not a note. */
const INDEX_FILE = '.shipwarden-notes.json';

interface NotesIndex {
    notes: Record<string, { tags: string[] }>;
}

/**
 * Keeps the notes: local files with any extension in one folder, like the scratch files of JetBrains IDEs.
 * A note can also be in a folder of the notes folder (one level). The tags are in an index file in the notes folder,
 * by the path of the note. The user and agents can open the files directly.
 */
export class NotesService {
    private readonly index: JsonStore<NotesIndex>;
    private watcher: FSWatcher | undefined;

    /** `trash` moves a file to the Trash. The tests replace it. */
    constructor(readonly folder: string, private readonly trash: (file: string) => Promise<void>) {
        this.index = new JsonStore<NotesIndex>(path.join(folder, INDEX_FILE), () => ({ notes: {} }));
    }

    /**
     * Walks the notes folder: the files and the folders at each level, up to the maximum depth. Hidden files and
     * folders (with a leading dot) are left out. Folder paths use "/".
     */
    private async walk(): Promise<{ files: { folder: string; fileName: string }[]; folders: string[] }> {
        await fs.mkdir(this.folder, { recursive: true });
        const files: { folder: string; fileName: string }[] = [];
        const folders: string[] = [];
        const visit = async (folder: string, depth: number) => {
            const entries = await fs.readdir(path.join(this.folder, ...folder.split('/').filter(Boolean)), { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue;
                if (entry.isFile()) {
                    files.push({ folder, fileName: entry.name });
                } else if (entry.isDirectory() && depth < MAX_FOLDER_DEPTH) {
                    const child = folder ? `${folder}/${entry.name}` : entry.name;
                    folders.push(child);
                    await visit(child, depth + 1);
                }
            }
        };
        await visit('', 0);
        return { files, folders };
    }

    /** Returns all notes (at the top level and in the folders at any depth), the newest change first. */
    async list(): Promise<NoteInfo[]> {
        const [{ files }, index] = await Promise.all([this.walk(), this.index.get()]);
        const notes = await Promise.all(files.map(async ({ folder, fileName }) => {
            const name = joinNotePath(folder, fileName);
            const stat = await fs.stat(this.file(name));
            return {
                name,
                fileName,
                folder,
                tags: normalizeTags(index.notes?.[name]?.tags),
                size: stat.size,
                createdAt: stat.birthtime.toISOString(),
                modifiedAt: stat.mtime.toISOString()
            };
        }));
        return notes.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    }

    /** Returns the paths of all folders ("a", "a/b"), also the empty folders, in alphabetical order. */
    async folders(): Promise<string[]> {
        const { folders } = await this.walk();
        return folders.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    }

    /** Makes a folder. The path can be in another folder ("a/b"). The parent folders are made when they do not exist. */
    async createFolder(name: string): Promise<string> {
        const folder = this.folderPath(name);
        await fs.mkdir(path.dirname(folder), { recursive: true });
        try {
            await fs.mkdir(folder);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`A folder or note with the name "${normalizeFolderPath(name)}" exists already.`);
            throw error;
        }
        return normalizeFolderPath(name);
    }

    /**
     * Renames a folder, or moves it into another folder ("a/b" to "c/b"). The notes in it keep their tags.
     * A folder cannot move into itself or into one of its own folders.
     */
    async renameFolder(name: string, newName: string): Promise<string> {
        const from = this.folderPath(name);
        const to = this.folderPath(newName);
        const source = normalizeFolderPath(name);
        const target = normalizeFolderPath(newName);
        if (from === to) return target;
        if (target.startsWith(`${source}/`)) throw new Error(`The folder "${source}" cannot move into itself.`);
        await fs.mkdir(path.dirname(to), { recursive: true });
        const exists = await fs.access(to).then(() => true, () => false);
        if (exists && source.toLowerCase() !== target.toLowerCase()) {
            throw new Error(`A folder or note with the name "${target}" exists already.`);
        }
        await fs.rename(from, to);
        await this.index.update(value => ({ notes: Object.fromEntries(Object.entries(value.notes ?? {}).map(([key, entry]) =>
            [key.startsWith(`${source}/`) ? `${target}/${key.slice(source.length + 1)}` : key, entry])) }));
        return target;
    }

    /** Moves a folder and its notes to the Trash. */
    async deleteFolder(name: string): Promise<void> {
        const source = normalizeFolderPath(name);
        await this.trash(this.folderPath(name));
        await this.index.update(value => ({ notes: Object.fromEntries(Object.entries(value.notes ?? {}).filter(([key]) => !key.startsWith(`${source}/`))) }));
    }

    async read(name: string): Promise<string> {
        const file = this.file(name);
        const stat = await fs.stat(file);
        if (stat.size > MAX_NOTE_BYTES) {
            throw new Error(`The note is ${Math.round(stat.size / 1024 / 1024)} MB. ShipWarden opens notes up to ${MAX_NOTE_BYTES / 1024 / 1024} MB.`);
        }
        const content = await fs.readFile(file, 'utf8');
        if (content.slice(0, 8000).includes('\0')) {
            throw new Error('The note is a binary file. Open it in another app.');
        }
        return content;
    }

    async write(name: string, content: string): Promise<void> {
        await fs.writeFile(this.file(name), content, 'utf8');
    }

    /** Makes a new note. The name must not be in use. A folder in the name is made when it does not exist. */
    async create(name: string, content = ''): Promise<NoteInfo> {
        await fs.mkdir(path.dirname(this.file(name)), { recursive: true });
        try {
            await fs.writeFile(this.file(name), content, { encoding: 'utf8', flag: 'wx' });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`A note with the name "${this.key(name)}" exists already.`);
            throw error;
        }
        return this.info(this.key(name));
    }

    /** Renames the file of a note, or moves it to another folder. The tags stay with the note. */
    async rename(name: string, newName: string): Promise<NoteInfo> {
        const from = this.file(name);
        const to = this.file(newName);
        const target = this.key(newName);
        if (from !== to) {
            // A rename to a name that differs only in case is the same file on macOS, so it is not a conflict.
            const exists = await fs.access(to).then(() => true, () => false);
            if (exists && this.key(name).toLowerCase() !== target.toLowerCase()) {
                throw new Error(`A note with the name "${target}" exists already.`);
            }
            await fs.mkdir(path.dirname(to), { recursive: true });
            await fs.rename(from, to);
            await this.index.update(value => {
                const notes = { ...value.notes };
                if (notes[this.key(name)]) {
                    notes[target] = notes[this.key(name)];
                    delete notes[this.key(name)];
                }
                return { notes };
            });
        }
        return this.info(target);
    }

    /** Moves the file of a note to the Trash, so the user can get it back. */
    async delete(name: string): Promise<void> {
        await this.trash(this.file(name));
        await this.index.update(value => {
            const notes = { ...value.notes };
            delete notes[this.key(name)];
            return { notes };
        });
    }

    async setTags(name: string, tags: string[]): Promise<NoteInfo> {
        await fs.access(this.file(name));
        const clean = normalizeTags(tags);
        await this.index.update(value => ({ notes: { ...value.notes, [this.key(name)]: { tags: clean } } }));
        return this.info(this.key(name));
    }

    /** The full path of a note, for "Reveal in Finder" and "Copy path". */
    pathOf(name: string): string {
        return this.file(name);
    }

    /** Calls `onChange` when a file in the folder changes, also from another app or an agent. */
    async watch(onChange: () => void): Promise<void> {
        await fs.mkdir(this.folder, { recursive: true });
        let timer: NodeJS.Timeout | undefined;
        this.watcher?.close();
        // Recursive, so a change in a folder of the notes folder counts too.
        this.watcher = watch(this.folder, { recursive: true }, () => {
            clearTimeout(timer);
            timer = setTimeout(onChange, 150);
        });
    }

    close(): void {
        this.watcher?.close();
        this.watcher = undefined;
    }

    private async info(name: string): Promise<NoteInfo> {
        const note = (await this.list()).find(item => item.name === name);
        if (!note) throw new Error(`The note "${name}" does not exist.`);
        return note;
    }

    /**
     * The path of a note file. The name can have one folder part. A part with a leading dot or a slash is refused,
     * so no path leaves the notes folder.
     */
    private file(name: string): string {
        const error = notePathError(String(name));
        if (error) throw new Error(error);
        const { folder, fileName } = splitNotePath(String(name));
        return path.join(this.folder, ...folder.split('/').filter(Boolean), fileName);
    }

    /** The index key of a note: its path, with no spaces around the parts. */
    private key(name: string): string {
        const { folder, fileName } = splitNotePath(String(name));
        return joinNotePath(folder, fileName);
    }

    private folderPath(name: string): string {
        const error = folderPathError(String(name));
        if (error) throw new Error(error);
        return path.join(this.folder, ...normalizeFolderPath(String(name)).split('/'));
    }
}
