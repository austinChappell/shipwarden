import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

/** Keeps a small JSON object in a file. Writes happen one at a time, in order. */
export class JsonStore<T extends object> {
    private value: T | undefined;
    private loading: Promise<T> | undefined;
    private writing: Promise<void> = Promise.resolve();

    constructor(private readonly file: string, private readonly initial: () => T) {}

    async get(): Promise<T> {
        // All callers wait for one read. Two reads at the same time can each set the value, and a change can go missing.
        this.loading ??= fs.readFile(this.file, 'utf8').then(
            text => JSON.parse(text) as T,
            () => this.initial()
        ).catch(() => this.initial());
        const loaded = await this.loading;
        this.value ??= loaded;
        return this.value;
    }

    async update(change: (value: T) => T | void): Promise<T> {
        await this.get();
        // Read the value after the wait, so that each change starts from the result of the change before it.
        const current = this.value as T;
        this.value = change(current) ?? current;
        const snapshot = JSON.stringify(this.value, null, 2);
        this.writing = this.writing.then(async () => {
            await fs.mkdir(path.dirname(this.file), { recursive: true });
            // Write a temporary file, then rename it. The rename is atomic, so a crash during the write does not damage the file.
            const temp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
            try {
                await fs.writeFile(temp, snapshot, { mode: 0o600 });
                await fs.rename(temp, this.file);
            } catch (error) {
                await fs.rm(temp, { force: true }).catch(() => undefined);
                throw error;
            }
        });
        await this.writing;
        return this.value;
    }
}
