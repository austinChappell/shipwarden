import { randomBytes } from 'crypto';
import { promises as fs, watch, type FSWatcher } from 'fs';
import * as path from 'path';
import { PromptTemplateError, isPromptTemplateId, normalizePromptTemplate, type PromptTemplate, type PromptTemplateList } from '@shared/prompt-templates';

/**
 * Keeps the prompt templates. Each template is one JSON file in the folder (~/.shipwarden/prompts/<id>.json), as with
 * the automations. The user can read, change, copy, and share the files. The store watches the folder, so a change from
 * another app shows at once.
 */
export class PromptStore {
    private watcher: FSWatcher | undefined;

    /** `trash` moves a file to the Trash. The tests replace it. */
    constructor(
        readonly folder: string,
        private readonly trash: (file: string) => Promise<void>
    ) {}

    /** Reads all template files. A file that is not valid goes into `problems`, with the reason. */
    async list(): Promise<PromptTemplateList> {
        await fs.mkdir(this.folder, { recursive: true });
        const files = (await fs.readdir(this.folder)).filter(file => file.endsWith('.json') && !file.startsWith('.')).sort();
        const templates: PromptTemplate[] = [];
        const problems: PromptTemplateList['problems'] = [];
        for (const file of files) {
            try {
                const template = normalizePromptTemplate(JSON.parse(await fs.readFile(path.join(this.folder, file), 'utf8')));
                // The file name is the ID. A copied file keeps the ID of the first file in its text.
                const id = file.slice(0, -'.json'.length);
                if (!isPromptTemplateId(id)) {
                    throw new PromptTemplateError('The file name must have only lowercase letters, digits, and hyphens.');
                }
                templates.push({ ...template, id });
            } catch (error) {
                problems.push({ file, error: error instanceof SyntaxError ? `The file is not valid JSON: ${error.message}` : errorText(error) });
            }
        }
        templates.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        return { folder: this.folder, templates, problems };
    }

    /**
     * Writes a template to its file and returns it in its clean form. With `previousId`, a template with a new ID
     * replaces the file of the old ID.
     */
    async save(value: unknown, previousId?: string): Promise<PromptTemplate> {
        const template = normalizePromptTemplate(value);
        if (!isPromptTemplateId(template.id)) throw new PromptTemplateError('The ID must have only lowercase letters, digits, and hyphens.');
        await fs.mkdir(this.folder, { recursive: true });
        await writeAtomic(this.fileOf(template.id), `${JSON.stringify(template, null, 2)}\n`);
        if (previousId && previousId !== template.id && isPromptTemplateId(previousId)) {
            await fs.rm(this.fileOf(previousId), { force: true });
        }
        return template;
    }

    /** Moves the file of the template to the Trash. */
    async remove(id: string): Promise<void> {
        if (!isPromptTemplateId(id)) return;
        const file = this.fileOf(id);
        if (await exists(file)) await this.trash(file);
    }

    /** Returns the path of the file of a template. */
    fileOf(id: string): string {
        if (!isPromptTemplateId(id)) throw new Error(`"${id}" is not a valid template ID.`);
        return path.join(this.folder, `${id}.json`);
    }

    /** Calls `onChange` when a file in the folder changes, also from another app. */
    async watch(onChange: () => void): Promise<void> {
        await fs.mkdir(this.folder, { recursive: true });
        let timer: NodeJS.Timeout | undefined;
        this.watcher?.close();
        this.watcher = watch(this.folder, () => {
            clearTimeout(timer);
            timer = setTimeout(onChange, 150);
        });
    }

    close(): void {
        this.watcher?.close();
        this.watcher = undefined;
    }
}

/** Writes a temporary file, then renames it. The rename is atomic, so a reader never sees half a file. */
async function writeAtomic(file: string, content: string): Promise<void> {
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
        await fs.writeFile(temp, content, { mode: 0o600 });
        await fs.rename(temp, file);
    } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        throw error;
    }
}

async function exists(file: string): Promise<boolean> {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
