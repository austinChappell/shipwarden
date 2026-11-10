import { describe, expect, it } from 'vitest';
import type { TextEdit } from 'vscode-languageserver-protocol';
import { applyTextEdits, collectFileEdits, toMonacoEdits } from './workspace-edit';

function edit(startLine: number, startCharacter: number, endLine: number, endCharacter: number, newText: string): TextEdit {
    return { range: { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } }, newText };
}

describe('collectFileEdits', () => {
    it('collects the edits of "changes"', () => {
        const result = collectFileEdits({ changes: { 'file:///a.ts': [edit(0, 0, 0, 1, 'x')], 'file:///b.ts': [edit(1, 0, 1, 0, 'y')] } });
        expect(result.resourceOperations).toEqual([]);
        expect(result.files).toEqual([
            { uri: 'file:///a.ts', version: undefined, edits: [edit(0, 0, 0, 1, 'x')] },
            { uri: 'file:///b.ts', version: undefined, edits: [edit(1, 0, 1, 0, 'y')] }
        ]);
    });

    it('uses "documentChanges" and ignores "changes"', () => {
        const result = collectFileEdits({
            changes: { 'file:///ignored.ts': [edit(0, 0, 0, 0, 'z')] },
            documentChanges: [
                { textDocument: { uri: 'file:///a.ts', version: 4 }, edits: [edit(0, 0, 0, 1, 'x')] },
                { textDocument: { uri: 'file:///a.ts', version: 4 }, edits: [{ ...edit(2, 0, 2, 0, 'y'), annotationId: 'note' }] }
            ]
        });
        expect(result.files).toEqual([{ uri: 'file:///a.ts', version: 4, edits: [edit(0, 0, 0, 1, 'x'), edit(2, 0, 2, 0, 'y')] }]);
    });

    it('reports file operations', () => {
        const result = collectFileEdits({
            documentChanges: [
                { kind: 'rename', oldUri: 'file:///a.ts', newUri: 'file:///b.ts' },
                { textDocument: { uri: 'file:///b.ts', version: null }, edits: [edit(0, 0, 0, 0, 'x')] }
            ]
        });
        expect(result.resourceOperations).toEqual(['rename']);
        expect(result.files).toHaveLength(1);
    });
});

describe('toMonacoEdits', () => {
    it('converts 0-based LSP ranges to 1-based Monaco ranges', () => {
        expect(toMonacoEdits([edit(0, 4, 1, 2, 'name')])).toEqual([
            { range: { startLineNumber: 1, startColumn: 5, endLineNumber: 2, endColumn: 3 }, text: 'name' }
        ]);
    });
});

describe('applyTextEdits', () => {
    it('applies edits that refer to the original text', () => {
        const text = 'const foo = 1;\nconsole.log(foo);\n';
        expect(applyTextEdits(text, [edit(1, 12, 1, 15, 'bar'), edit(0, 6, 0, 9, 'bar')])).toBe('const bar = 1;\nconsole.log(bar);\n');
    });

    it('keeps the list order of inserts at the same position', () => {
        expect(applyTextEdits('ab', [edit(0, 1, 0, 1, 'x'), edit(0, 1, 0, 1, 'y')])).toBe('axyb');
    });

    it('keeps "\\r\\n" line breaks', () => {
        expect(applyTextEdits('a\r\nfoo\r\n', [edit(1, 0, 1, 3, 'bar')])).toBe('a\r\nbar\r\n');
    });

    it('moves a character after the line end to the line end', () => {
        expect(applyTextEdits('ab\r\ncd', [edit(0, 99, 0, 99, '!')])).toBe('ab!\r\ncd');
    });

    it('moves a line after the last line to the text end', () => {
        expect(applyTextEdits('a\n', [edit(5, 0, 5, 0, 'b')])).toBe('a\nb');
    });

    it('can delete a line break', () => {
        expect(applyTextEdits('a\nb', [edit(0, 1, 1, 0, ' ')])).toBe('a b');
    });

    it('refuses edits that overlap', () => {
        expect(() => applyTextEdits('abcdef', [edit(0, 0, 0, 3, 'x'), edit(0, 2, 0, 4, 'y')])).toThrow('Two edits change the same text.');
    });
});
