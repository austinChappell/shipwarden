import { describe, expect, it } from 'vitest';
import {
    attachmentKindOf,
    capText,
    type ConvertedDocument,
    documentKindOf,
    documentPrompt,
    extensionOf,
    MAX_DOCUMENT_CHARS,
    truncationNote,
    unsupportedFileText
} from './documents';

const report: ConvertedDocument = { kind: 'text', name: 'report.pdf', textPath: '/data/a/report.pdf.txt', chars: 1200, truncated: false, pages: 3 };
const sheet: ConvertedDocument = { kind: 'text', name: 'data.xlsx', textPath: '/data/b/data.xlsx.txt', chars: 500_000, truncated: true };
const scan: ConvertedDocument = {
    kind: 'images',
    name: 'scan.pdf',
    images: ['data:image/png;base64,AA', 'data:image/png;base64,BB'],
    pages: 9,
    truncated: true
};

describe('document kinds', () => {
    it('finds the kind from the extension', () => {
        expect(documentKindOf('Report.PDF')).toBe('pdf');
        expect(documentKindOf('notes.docx')).toBe('word');
        expect(documentKindOf('old.doc')).toBe('word');
        expect(documentKindOf('letter.rtf')).toBe('word');
        expect(documentKindOf('table.xlsx')).toBe('spreadsheet');
        expect(documentKindOf('table.csv')).toBe('text');
        expect(documentKindOf('table.tsv')).toBe('text');
        expect(documentKindOf('old.xls')).toBeUndefined();
        expect(documentKindOf('Makefile')).toBeUndefined();
        expect(documentKindOf('constructor')).toBeUndefined();
        expect(documentKindOf('a.toString')).toBeUndefined();
    });

    it('reads the extension of a path', () => {
        expect(extensionOf('/Users/me/My.Files/report.final.PDF')).toBe('pdf');
        expect(extensionOf('/Users/me/.hidden')).toBe('');
        expect(extensionOf('/Users/me.dir/noext')).toBe('');
    });

    it('attaches images as images and documents as documents', () => {
        expect(attachmentKindOf('shot.png', 'image/png')).toBe('image');
        expect(attachmentKindOf('photo.JPG')).toBe('image');
        expect(attachmentKindOf('image', 'image/png')).toBe('image');
        expect(attachmentKindOf('report.pdf', 'application/pdf')).toBe('document');
        expect(attachmentKindOf('photo.heic', 'image/heic')).toBe('unsupported');
        expect(attachmentKindOf('deck.key')).toBe('unsupported');
    });

    it('names the file and the supported types in the error', () => {
        const text = unsupportedFileText('deck.key');
        expect(text).toContain('"deck.key"');
        expect(text).toContain('PDF');
        expect(text).toContain('Excel (.xlsx)');
    });
});

describe('capText', () => {
    it('keeps a short text', () => {
        expect(capText('hello', 10)).toEqual({ text: 'hello', truncated: false });
    });

    it('cuts a long text to the maximum', () => {
        expect(capText('abcdefghij', 4)).toEqual({ text: 'abcd', truncated: true });
        expect(capText('x'.repeat(MAX_DOCUMENT_CHARS + 1)).text).toHaveLength(MAX_DOCUMENT_CHARS);
    });

    it('does not cut a surrogate pair', () => {
        expect(capText('ab😀cd', 3)).toEqual({ text: 'ab', truncated: true });
    });
});

describe('documentPrompt', () => {
    it('returns the text without documents', () => {
        expect(documentPrompt([], 'Fix the bug')).toBe('Fix the bug');
    });

    it('lists the text files, then the prompt', () => {
        expect(documentPrompt([report, sheet], 'Compare them')).toBe(
            [
                'I attached documents. ShipWarden converted each document to a text file. Read the text files:',
                '- report.pdf (3 pages): /data/a/report.pdf.txt',
                '- data.xlsx (cut to the first 500,000 characters): /data/b/data.xlsx.txt',
                '',
                'Compare them'
            ].join('\n')
        );
    });

    it('tells the agent about the page images of a PDF without text', () => {
        expect(documentPrompt([scan], '')).toBe('I attached documents:\n- scan.pdf: the PDF has no text. This prompt has the first 2 of 9 pages as images.');
        expect(documentPrompt([{ ...scan, images: ['x'], pages: 1, truncated: false }], '')).toContain('This prompt has the page as images.');
    });

    it('writes a note for a cut document', () => {
        expect(truncationNote(report)).toBeUndefined();
        expect(truncationNote(sheet)).toBe('The document is long. The agent gets the first 500,000 characters.');
        expect(truncationNote(scan)).toBe('The agent gets the first 2 of 9 pages as images.');
    });
});
