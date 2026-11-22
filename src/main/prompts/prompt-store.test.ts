import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PromptTemplate } from '@shared/prompt-templates';
import { PromptStore } from './prompt-store';

const template: PromptTemplate = { version: 1, id: 'write-tests', name: 'Write tests', prompt: 'Write tests for {{file}}', shortcut: '⌃⌥T' };

describe('PromptStore', () => {
    let root: string;
    let folder: string;
    let store: PromptStore;
    let trashed: string[];

    beforeEach(async () => {
        root = await mkdtemp(path.join(os.tmpdir(), 'prompts-'));
        folder = path.join(root, 'prompts');
        trashed = [];
        store = new PromptStore(folder, async file => {
            trashed.push(file);
            await rm(file);
        });
    });

    afterEach(async () => {
        store.close();
        await rm(root, { recursive: true, force: true });
    });

    it('saves each template as one JSON file and lists it', async () => {
        await store.save(template);
        const text = await readFile(path.join(folder, 'write-tests.json'), 'utf8');
        expect(JSON.parse(text)).toEqual(template);
        expect(await store.list()).toEqual({ folder, templates: [template], problems: [] });
    });

    it('sorts the templates by name, and uses the file name as the ID', async () => {
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, 'copy.json'), JSON.stringify({ ...template, id: 'other', name: 'b template' }));
        await store.save({ ...template, id: 'first', name: 'A template' });
        const list = await store.list();
        expect(list.templates.map(item => [item.id, item.name])).toEqual([
            ['first', 'A template'],
            ['copy', 'b template']
        ]);
    });

    it('reports files that are not valid', async () => {
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, 'broken.json'), '{');
        await writeFile(path.join(folder, 'empty.json'), JSON.stringify({ name: 'x' }));
        await writeFile(path.join(folder, 'Bad Name.json'), JSON.stringify(template));
        await writeFile(path.join(folder, 'notes.txt'), 'not a template');
        const list = await store.list();
        expect(list.templates).toEqual([]);
        expect(list.problems.map(problem => problem.file)).toEqual(['Bad Name.json', 'broken.json', 'empty.json']);
        expect(list.problems[1].error).toContain('not valid JSON');
        expect(list.problems[2].error).toContain('no prompt');
    });

    it('replaces the file of the old ID after a rename', async () => {
        await store.save(template);
        await store.save({ ...template, id: 'tests' }, 'write-tests');
        expect((await store.list()).templates.map(item => item.id)).toEqual(['tests']);
    });

    it('rejects a template with an ID that cannot be a file name', async () => {
        await expect(store.save({ ...template, id: '../x' })).rejects.toThrow('lowercase');
    });

    it('moves the file to the Trash on remove', async () => {
        await store.save(template);
        await store.remove('write-tests');
        await store.remove('missing');
        expect(trashed).toEqual([path.join(folder, 'write-tests.json')]);
        expect((await store.list()).templates).toEqual([]);
    });
});
