import { describe, expect, it } from 'vitest';
import { ftsQueryOf, indexTranscriptLines, inFolders, MAX_ENTRY_CHARS, SNIPPET_END, SNIPPET_START, snippetParts } from './transcript-search';

const line = (value: unknown) => JSON.stringify(value);

describe('indexTranscriptLines', () => {
    it('reads prompts, agent text, tool call paths, the model, and the summary', () => {
        const result = indexTranscriptLines({}, [
            line({ type: 'user', cwd: '/w/app', gitBranch: 'fix', entrypoint: 'cli', timestamp: '2026-11-19T10:00:00Z', message: { content: 'Fix it' } }),
            line({
                type: 'assistant',
                timestamp: '2026-11-19T10:00:01Z',
                message: {
                    model: 'claude-sonnet-4-5',
                    content: [
                        { type: 'thinking', thinking: 'hidden' },
                        { type: 'text', text: ' Done. ' },
                        { type: 'tool_use', name: 'Read', input: { file_path: '/w/app/a.ts' } },
                        { type: 'tool_use', name: 'Grep', input: { pattern: 'x', path: '/w/app/src' } },
                        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }
                    ]
                }
            }),
            line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'output' }] } }),
            line({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response' }] } }),
            'not json'
        ]);
        const time = Date.parse('2026-11-19T10:00:01Z');
        expect(result.entries).toEqual([
            { kind: 'prompt', text: 'Fix it', at: Date.parse('2026-11-19T10:00:00Z') },
            { kind: 'text', text: 'Done.', at: time },
            { kind: 'file', text: '/w/app/a.ts', at: time },
            { kind: 'file', text: '/w/app/src', at: time },
            { kind: 'text', text: 'No response', at: undefined }
        ]);
        expect(result.model).toBe('claude-sonnet-4-5');
        expect(result.summary).toEqual({ cwd: '/w/app', branch: 'fix', entrypoint: 'cli', firstPrompt: 'Fix it' });
    });

    it('cuts a long text', () => {
        const result = indexTranscriptLines({}, [line({ type: 'user', message: { content: 'x'.repeat(MAX_ENTRY_CHARS + 10) } })]);
        expect(result.entries[0].text).toHaveLength(MAX_ENTRY_CHARS);
    });
});

describe('ftsQueryOf', () => {
    it('quotes each word and lets the last word be a prefix', () => {
        expect(ftsQueryOf('auth.ts  login')).toBe('"auth.ts" "login"*');
        expect(ftsQueryOf('say "hi"')).toBe('"say" "hi"*');
        expect(ftsQueryOf(' - " ')).toBeUndefined();
        expect(ftsQueryOf('')).toBeUndefined();
    });
});

describe('inFolders', () => {
    it('matches the folder and the folders in it', () => {
        expect(inFolders('/w/app', undefined)).toBe(true);
        expect(inFolders('/w/app', [])).toBe(true);
        expect(inFolders('/w/app', ['/w/app'])).toBe(true);
        expect(inFolders('/w/app/sub', ['/w/app/'])).toBe(true);
        expect(inFolders('/w/app-2', ['/w/app'])).toBe(false);
    });
});

describe('snippetParts', () => {
    it('splits the marked words from the plain text', () => {
        expect(snippetParts(`…the ${SNIPPET_START}auth${SNIPPET_END}.${SNIPPET_START}ts${SNIPPET_END} file\nis`)).toEqual([
            { text: '…the ', mark: false },
            { text: 'auth', mark: true },
            { text: '.', mark: false },
            { text: 'ts', mark: true },
            { text: ' file is', mark: false }
        ]);
        expect(snippetParts('plain')).toEqual([{ text: 'plain', mark: false }]);
    });
});
