import { promises as fs } from 'fs';
import * as path from 'path';

/** Keeps a small JSON object in a file. Writes happen one at a time, in order. */
export class JsonStore<T extends object> {
    private value: T | undefined;
    private writing: Promise<void> = Promise.resolve();

    constructor(private readonly file: string, private readonly initial: () => T) {}

    async get(): Promise<T> {
        if (!this.value) {
            try {
                this.value = JSON.parse(await fs.readFile(this.file, 'utf8')) as T;
            } catch {
                this.value = this.initial();
            }
        }
        return this.value;
    }

    async update(change: (value: T) => T | void): Promise<T> {
        const current = await this.get();
        this.value = change(current) ?? current;
        const snapshot = JSON.stringify(this.value, null, 2);
        this.writing = this.writing.then(async () => {
            await fs.mkdir(path.dirname(this.file), { recursive: true });
            await fs.writeFile(this.file, snapshot, { mode: 0o600 });
        });
        await this.writing;
        return this.value;
    }
}
