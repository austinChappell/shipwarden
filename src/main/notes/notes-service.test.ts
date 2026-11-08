import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotesService } from './notes-service';

describe('NotesService', () => {
    let folder: string;
    let trashed: string[];
    let notes: NotesService;

    beforeEach(async () => {
        folder = path.join(await mkdtemp(path.join(os.tmpdir(), 'notes-')), 'notes');
        trashed = [];
        notes = new NotesService(folder, async file => {
            trashed.push(file);
            await rm(file, { recursive: true });
        });
    });

    afterEach(async () => {
        notes.close();
        await rm(path.dirname(folder), { recursive: true, force: true });
    });

    it('creates, reads, writes and lists notes with any extension', async () => {
        await notes.create('query.sql', 'select 1;');
        await notes.create('todo');
        await notes.write('todo', '- one');
        expect(await notes.read('query.sql')).toBe('select 1;');
        expect(await readFile(path.join(folder, 'todo'), 'utf8')).toBe('- one');
        expect((await notes.list()).map(note => note.name).sort()).toEqual(['query.sql', 'todo']);
        await expect(notes.create('todo')).rejects.toThrow(/exists already/);
    });

    it('keeps the tags in the index, also after a rename', async () => {
        await notes.create('a.md');
        expect((await notes.setTags('a.md', ['#work', 'Work', 'sql'])).tags).toEqual(['work', 'sql']);
        const renamed = await notes.rename('a.md', 'b.md');
        expect(renamed).toMatchObject({ name: 'b.md', tags: ['work', 'sql'] });
        const listed = await notes.list();
        expect(listed.map(note => note.name)).toEqual(['b.md']);
        expect(JSON.parse(await readFile(path.join(folder, '.shipwarden-notes.json'), 'utf8')).notes).toEqual({ 'b.md': { tags: ['work', 'sql'] } });
    });

    it('does not rename over another note', async () => {
        await notes.create('a.md');
        await notes.create('b.md');
        await expect(notes.rename('a.md', 'b.md')).rejects.toThrow(/exists already/);
    });

    it('moves a deleted note to the trash and removes its tags', async () => {
        await notes.create('a.md');
        await notes.setTags('a.md', ['x']);
        await notes.delete('a.md');
        expect(trashed).toEqual([path.join(folder, 'a.md')]);
        expect(await notes.list()).toEqual([]);
    });

    it('refuses names that leave the folder and binary files', async () => {
        await expect(notes.read('../secret')).rejects.toThrow(/dot/);
        await expect(notes.read('a/../../c.md')).rejects.toThrow(/dot/);
        await expect(notes.read(`${'a/'.repeat(11)}c.md`)).rejects.toThrow(/levels deep/);
        await expect(notes.write('.shipwarden-notes.json', '{}')).rejects.toThrow(/dot/);
        await notes.create('x.bin');
        await writeFile(path.join(folder, 'x.bin'), Buffer.from([0, 1, 2]));
        await expect(notes.read('x.bin')).rejects.toThrow(/binary/);
    });

    it('keeps notes in folders, and moves a note with its tags', async () => {
        await notes.createFolder('sql');
        await notes.createFolder('empty');
        await notes.create('sql/a.sql', 'select 1;');
        await notes.create('top.md');
        expect(await notes.folders()).toEqual(['empty', 'sql']);
        const listed = await notes.list();
        expect(listed.find(note => note.name === 'sql/a.sql')).toMatchObject({ fileName: 'a.sql', folder: 'sql' });
        expect(listed.find(note => note.name === 'top.md')).toMatchObject({ fileName: 'top.md', folder: '' });

        await notes.setTags('sql/a.sql', ['db']);
        // A move to the top level, and back into a folder that the move makes.
        expect(await notes.rename('sql/a.sql', 'a.sql')).toMatchObject({ name: 'a.sql', folder: '', tags: ['db'] });
        expect(await notes.rename('a.sql', 'new/a.sql')).toMatchObject({ name: 'new/a.sql', folder: 'new', tags: ['db'] });
        expect(await readFile(path.join(folder, 'new', 'a.sql'), 'utf8')).toBe('select 1;');
        await expect(notes.createFolder('sql')).rejects.toThrow(/exists already/);
    });

    it('renames a folder with the tags of its notes, and deletes a folder with its notes', async () => {
        await notes.create('work/plan.md');
        await notes.setTags('work/plan.md', ['q3']);
        await notes.renameFolder('work', 'job');
        expect((await notes.list()).map(note => [note.name, note.tags])).toEqual([['job/plan.md', ['q3']]]);
        await notes.deleteFolder('job');
        expect(trashed).toEqual([path.join(folder, 'job')]);
        expect(await notes.list()).toEqual([]);
        expect(JSON.parse(await readFile(path.join(folder, '.shipwarden-notes.json'), 'utf8')).notes).toEqual({});
    });

    it('keeps notes in nested folders, and moves a folder into another folder', async () => {
        await notes.createFolder('work/2026/q4');
        await notes.create('work/2026/q4/plan.md', 'plan');
        await notes.setTags('work/2026/q4/plan.md', ['q4']);
        expect(await notes.folders()).toEqual(['work', 'work/2026', 'work/2026/q4']);
        expect((await notes.list())[0]).toMatchObject({ name: 'work/2026/q4/plan.md', folder: 'work/2026/q4', fileName: 'plan.md' });

        await notes.createFolder('archive');
        expect(await notes.renameFolder('work/2026', 'archive/2026')).toBe('archive/2026');
        expect(await notes.folders()).toEqual(['archive', 'archive/2026', 'archive/2026/q4', 'work']);
        expect((await notes.list()).map(note => [note.name, note.tags])).toEqual([['archive/2026/q4/plan.md', ['q4']]]);
        expect(await readFile(path.join(folder, 'archive', '2026', 'q4', 'plan.md'), 'utf8')).toBe('plan');

        await expect(notes.renameFolder('archive', 'archive/2026/archive')).rejects.toThrow(/into itself/);
    });
});
