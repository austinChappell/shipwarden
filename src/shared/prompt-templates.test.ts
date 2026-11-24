import { describe, expect, it } from 'vitest';
import {
    fillPrompt,
    formatKeys,
    missingVariables,
    normalizePromptTemplate,
    parseShortcut,
    promptTemplateId,
    promptValues,
    promptVariables,
    PromptTemplateError,
    shortcutConflict,
    shortcutOfEvent,
    STARTER_PROMPTS,
    templateForKey,
    type PromptTemplate
} from './prompt-templates';
import type { TextKeybind } from './terminal';

const template = (change: Partial<PromptTemplate> = {}): PromptTemplate => ({
    version: 1,
    id: 'write-tests',
    name: 'Write tests',
    prompt: 'Write tests for {{file}}',
    ...change
});

const key = (code: string, mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {}) => ({
    key: code.startsWith('Key') ? code.slice(3).toLowerCase() : code,
    code,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift
});

describe('normalizePromptTemplate', () => {
    it('keeps the fields and writes the shortcut in one form', () => {
        expect(normalizePromptTemplate({ id: 'a', name: ' Fix lint ', prompt: 'Fix {{branch}}', shortcut: '⌥⌃L', send: true, extra: 1 })).toEqual({
            version: 1,
            id: 'a',
            name: 'Fix lint',
            prompt: 'Fix {{branch}}',
            shortcut: '⌃⌥L',
            send: true
        });
    });

    it('rejects a template without a name, a prompt, or a valid shortcut', () => {
        expect(() => normalizePromptTemplate({ prompt: 'x' })).toThrow(PromptTemplateError);
        expect(() => normalizePromptTemplate({ name: 'x', prompt: '  ' })).toThrow('no prompt');
        expect(() => normalizePromptTemplate({ name: 'x', prompt: 'y', shortcut: 'T' })).toThrow('not valid');
        expect(() => normalizePromptTemplate({ name: 'x', prompt: 'y', shortcut: '⇧T' })).toThrow('not valid');
    });

    it('drops a false "send" and an empty shortcut', () => {
        expect(normalizePromptTemplate({ id: 'a', name: 'x', prompt: 'y', shortcut: '', send: false })).toEqual({
            version: 1,
            id: 'a',
            name: 'x',
            prompt: 'y'
        });
    });
});

describe('promptTemplateId', () => {
    it('makes a file name from the name, and does not reuse an ID', () => {
        expect(promptTemplateId('Write tests!', [])).toBe('write-tests');
        expect(promptTemplateId('Write tests', ['write-tests'])).toBe('write-tests-2');
        expect(promptTemplateId('!!!', [])).toBe('prompt');
    });
});

describe('variables', () => {
    it('uses the variables of the automations, plus "file"', () => {
        const names = promptVariables().map(variable => variable.name);
        expect(names).toEqual(expect.arrayContaining(['file', 'branch', 'repo', 'worktree', 'pr.url', 'task.key', 'date']));
        expect(names).not.toContain('task.description');
    });

    it('fills the values from the worktree, the pull request, and the task link', () => {
        const values = promptValues({
            place: { repo: '/code/api', worktree: { path: '/wt/fix-login', branch: 'fix-login', isMain: false } },
            file: 'src/login.ts',
            summary: { number: 12, title: 'Fix login', url: 'https://github.com/acme/api/pull/12', headSha: 'abc', isDraft: false } as never,
            taskLink: { pluginId: 'jira', taskId: '1', key: 'ENG-1', title: 'Login fails' },
            at: new Date(2026, 10, 19, 8, 5).getTime()
        });
        expect(values).toMatchObject({
            file: 'src/login.ts',
            branch: 'fix-login',
            repo: 'api',
            worktree: '/wt/fix-login',
            'pr.number': '12',
            'pr.url': 'https://github.com/acme/api/pull/12',
            'task.key': 'ENG-1',
            date: '2026-11-19',
            time: '08:05'
        });
        expect(fillPrompt('Write tests for {{file}} on {{branch}}', values)).toBe('Write tests for src/login.ts on fix-login');
    });

    it('finds the variables without a value: unknown values, empty values, and free variables', () => {
        const values = promptValues({ place: { repo: '/code/api', worktree: { path: '/wt/a', branch: 'a', isMain: false } }, at: 0 });
        expect(missingVariables('Fix {{branch}} in {{file}} for {{focus}} and {{pr.url}}, {{file}}', values)).toEqual(['file', 'focus', 'pr.url']);
        expect(missingVariables('Fix {{x}}', { x: '   ' })).toEqual(['x']);
        expect(missingVariables('No variables', {})).toEqual([]);
    });

    it('has starter templates with valid IDs and texts', () => {
        expect(STARTER_PROMPTS.length).toBeGreaterThanOrEqual(3);
        for (const starter of STARTER_PROMPTS) expect(normalizePromptTemplate(starter)).toEqual(starter);
    });
});

describe('shortcuts', () => {
    it('needs ⌘, ⌃, or ⌥', () => {
        expect(parseShortcut('⌃⌥T')).toMatchObject({ control: true, alt: true, code: 'KeyT' });
        expect(parseShortcut('⇧T')).toBeUndefined();
        expect(parseShortcut('T')).toBeUndefined();
        expect(parseShortcut('nonsense')).toBeUndefined();
    });

    it('writes the modifiers in the order of macOS', () => {
        expect(formatKeys(parseShortcut('⇧⌥⌘1')!)).toBe('⌥⇧⌘1');
        expect(formatKeys(parseShortcut('⌘[')!)).toBe('⌘[');
    });

    it('reads a key event by the code of the key, so ⌥ does not change the letter', () => {
        expect(shortcutOfEvent({ ...key('KeyT', { ctrl: true, alt: true }), key: '†' })).toBe('⌃⌥T');
        expect(shortcutOfEvent(key('Digit2', { meta: true, shift: true }))).toBe('⇧⌘2');
        expect(shortcutOfEvent(key('KeyT', { shift: true }))).toBeUndefined();
        expect(shortcutOfEvent(key('Enter', { meta: true }))).toBeUndefined();
        expect(shortcutOfEvent({ ...key('ShiftLeft', { shift: true, meta: true }), key: 'Shift' })).toBeUndefined();
    });

    it('finds the template of a key', () => {
        const templates = [template({ shortcut: '⌃⌥T' }), template({ id: 'b', name: 'B' })];
        expect(templateForKey(templates, key('KeyT', { ctrl: true, alt: true }))?.id).toBe('write-tests');
        expect(templateForKey(templates, key('KeyT', { ctrl: true }))).toBeUndefined();
    });

    it('rejects a key of ShipWarden, of macOS, of the terminal, or of another template', () => {
        expect(shortcutConflict('⌘T', [], undefined)).toContain('New shell tab');
        expect(shortcutConflict('⇧⌘P', [], undefined)).toContain('command palette');
        expect(shortcutConflict('⌘Q', [], undefined)).toContain('Quit');
        expect(shortcutConflict('⌘K', [], undefined)).toContain('Clear');
        expect(shortcutConflict('⌥⌘3', [], undefined)).toContain('Tasks');
        expect(shortcutConflict('⌥⌘O', [], undefined)).toContain('external editor');
        expect(shortcutConflict('⌘C', [], undefined)).toContain('Copy');
        const keybind: TextKeybind = { key: 'j', shift: false, ctrl: true, alt: true, meta: false, text: '\n' };
        expect(shortcutConflict('⌃⌥J', [], undefined, [keybind])).toContain('terminal');
        const templates = [template({ shortcut: '⌃⌥T' })];
        expect(shortcutConflict('⌃⌥T', templates, 'other')).toContain('Write tests');
        expect(shortcutConflict('⌃⌥T', templates, 'write-tests')).toBeUndefined();
        expect(shortcutConflict('⌃⌥Y', templates, undefined)).toBeUndefined();
        expect(shortcutConflict('Y', templates, undefined)).toContain('not a valid');
    });
});
