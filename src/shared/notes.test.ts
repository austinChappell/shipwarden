import { describe, expect, it } from 'vitest';
import {
    folderBaseName,
    folderMoveTargets,
    folderNameError,
    folderPathError,
    joinNotePath,
    parentFolder,
    noteMatches,
    noteNameError,
    normalizeTags,
    notePathError,
    splitNotePath,
    tagOptions,
    uniqueNoteName,
    type NoteInfo
} from './notes';

describe('noteNameError', () => {
    it('accepts a file name with any extension', () => {
        expect(noteNameError('queries.sql')).toBeUndefined();
        expect(noteNameError('todo')).toBeUndefined();
        expect(noteNameError('my notes.tar.gz')).toBeUndefined();
    });

    it('refuses empty names, folders, hidden files and long names', () => {
        expect(noteNameError('  ')).toMatch(/Type a name/);
        expect(noteNameError('../x.md')).toMatch(/cannot contain/);
        expect(noteNameError('a/b.md')).toMatch(/cannot contain/);
        expect(noteNameError('.notes.json')).toMatch(/dot/);
        expect(noteNameError('x'.repeat(201))).toMatch(/too long/);
    });
});

describe('normalizeTags', () => {
    it('trims, removes "#", joins words and removes duplicates', () => {
        expect(normalizeTags([' #sql ', 'SQL', 'work notes', '', 3, 'deploy'])).toEqual(['sql', 'work-notes', 'deploy']);
        expect(normalizeTags('x')).toEqual([]);
    });
});

describe('uniqueNoteName', () => {
    it('adds a number before the extension', () => {
        expect(uniqueNoteName('scratch.md', [])).toBe('scratch.md');
        expect(uniqueNoteName('scratch.md', ['Scratch.md', 'scratch-2.md'])).toBe('scratch-3.md');
        expect(uniqueNoteName('todo', ['todo'])).toBe('todo-2');
    });
});

describe('noteMatches', () => {
    const note: NoteInfo = { name: 'deploy-steps.sh', fileName: 'deploy-steps.sh', folder: '', tags: ['ops', 'Prod'], size: 1, createdAt: '', modifiedAt: '' };

    it('matches words in the name and tags, and all selected tags', () => {
        expect(noteMatches(note, 'deploy', [])).toBe(true);
        expect(noteMatches(note, '#ops steps', [])).toBe(true);
        expect(noteMatches(note, '', ['prod', 'ops'])).toBe(true);
        expect(noteMatches(note, '', ['sql'])).toBe(false);
        expect(noteMatches(note, 'missing', [])).toBe(false);
    });
});

describe('tagOptions', () => {
    const all = ['ops', 'SQL', 'work'];

    it('lists the tags that the note does not have, also with no search text', () => {
        expect(tagOptions('', ['work'], all)).toEqual([
            { tag: 'ops', create: false },
            { tag: 'SQL', create: false }
        ]);
    });

    it('filters by the search text and offers to create a new tag', () => {
        expect(tagOptions('#s', [], all)).toEqual([
            { tag: 'ops', create: false },
            { tag: 'SQL', create: false },
            { tag: 's', create: true }
        ]);
        expect(tagOptions('release notes', [], all)).toEqual([{ tag: 'release-notes', create: true }]);
    });

    it('does not offer to create a tag that exists, ignoring case', () => {
        expect(tagOptions('sql', [], all)).toEqual([{ tag: 'SQL', create: false }]);
        expect(tagOptions('WORK', ['work'], all)).toEqual([]);
    });
});

describe('note paths', () => {
    it('splits and joins a path with nested folders', () => {
        expect(splitNotePath('sql/a.sql')).toEqual({ folder: 'sql', fileName: 'a.sql' });
        expect(splitNotePath('a / b/c.md')).toEqual({ folder: 'a/b', fileName: 'c.md' });
        expect(joinNotePath('a/b/', 'c.md')).toBe('a/b/c.md');
        expect(parentFolder('a/b')).toBe('a');
        expect(parentFolder('a')).toBe('');
        expect(folderBaseName('a/b')).toBe('b');
        expect(splitNotePath('a.sql')).toEqual({ folder: '', fileName: 'a.sql' });
        expect(joinNotePath('', 'a.sql')).toBe('a.sql');
        expect(joinNotePath(' sql ', 'a.sql')).toBe('sql/a.sql');
    });

    it('accepts nested folders up to the maximum depth, and refuses bad folder names', () => {
        expect(notePathError('sql/a.sql')).toBeUndefined();
        expect(notePathError('a/b/c.md')).toBeUndefined();
        expect(notePathError(`${'a/'.repeat(11)}c.md`)).toMatch(/levels deep/);
        expect(folderPathError('a//b')).toMatch(/Type a folder name/);
        expect(notePathError('.hidden/a.md')).toMatch(/dot/);
        expect(folderNameError('')).toMatch(/Type a folder name/);
    });
});

describe('folderMoveTargets', () => {
    it('removes the folder and the folders in it', () => {
        expect(folderMoveTargets(['a', 'a/b', 'ab', 'c', 'c/a'], 'a')).toEqual(['ab', 'c', 'c/a']);
        expect(folderMoveTargets(['a', 'a/b', 'a/b/c'], 'a/b')).toEqual(['a']);
    });
});
