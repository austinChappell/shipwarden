// Keeps the tasks of one collection in a JSON file.
// A write goes to a temporary file first. Then a rename replaces the file. A crash during a write does not damage the file.
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** The version of the file format. */
export const FILE_VERSION = 1;

/** Returns the content of a new task file. */
export function emptyFile() {
    return { version: FILE_VERSION, nextNumber: 1, tasks: [] };
}

/**
 * Writes a text to a file. The text goes to a temporary file in the same folder, then a rename replaces the file.
 * The rename is atomic, so a reader sees the old file or the new file, never a part of a file.
 */
export async function writeFileAtomic(file, text) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    let handle;
    try {
        handle = await fs.open(temp, 'w', 0o644);
        await handle.writeFile(text, 'utf8');
        // Put the data on the disk before the rename. Else a power loss can leave an empty file after the rename.
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.rename(temp, file);
    } catch (error) {
        await handle?.close().catch(() => undefined);
        await fs.rm(temp, { force: true }).catch(() => undefined);
        throw error;
    }
}

/** Checks the content of a task file and adds the missing parts. Throws an error when the content is not a task file. */
export function normalizeFile(value, file) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.tasks)) {
        throw new Error(`The task file ${file} is not a ShipWarden task file. Correct the file or move it to a different location.`);
    }
    const tasks = value.tasks.filter(task => task && typeof task === 'object' && Number.isInteger(task.number) && typeof task.title === 'string');
    const highest = tasks.reduce((max, task) => Math.max(max, task.number), 0);
    const nextNumber = Number.isInteger(value.nextNumber) && value.nextNumber > highest ? value.nextNumber : highest + 1;
    return {
        ...value,
        version: FILE_VERSION,
        nextNumber,
        tasks: tasks.map(task => ({ ...task, comments: Array.isArray(task.comments) ? task.comments : [] }))
    };
}

/**
 * One task file. Each read gets the file from the disk again, because a person, an agent or a different process can
 * change the file. The changes in this process occur one at a time, in order.
 */
export class TaskFile {
    constructor(file) {
        this.file = file;
        this.queue = Promise.resolve();
        /** The text of the last write of this process. The file watcher uses it to ignore the changes of this process. */
        this.lastWritten = undefined;
    }

    /** Reads the file. A missing file is an empty task file. A file that is not valid JSON causes an error, so that no write replaces it. */
    async read() {
        let text;
        try {
            text = await fs.readFile(this.file, 'utf8');
        } catch (error) {
            if (error?.code === 'ENOENT') {
                return emptyFile();
            }
            throw new Error(`ShipWarden cannot read the task file ${this.file}: ${error?.message ?? error}`);
        }
        if (!text.trim()) {
            return emptyFile();
        }
        let value;
        try {
            value = JSON.parse(text);
        } catch (error) {
            throw new Error(`The task file ${this.file} is not valid JSON (${error.message}). Correct the file. ShipWarden does not write to it until then.`);
        }
        return normalizeFile(value, this.file);
    }

    /**
     * Reads the file, gives the content to `change` and writes the result. `change` can change the content in place.
     * Returns the value that `change` returns.
     */
    update(change) {
        const run = this.queue.then(async () => {
            const data = await this.read();
            const result = await change(data);
            const text = `${JSON.stringify(data, null, 2)}\n`;
            this.lastWritten = text;
            await writeFileAtomic(this.file, text);
            return result;
        });
        // A failed change must not stop the next changes.
        this.queue = run.catch(() => undefined);
        return run;
    }
}
