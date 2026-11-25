import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_DOCUMENT_CHARS, MAX_PDF_IMAGE_PAGES } from '@shared/documents';
import { DocumentConverter, pdfHasNoText, pdfPagesToText, type RunTool } from './document-converter';
import { makeZip, WORKBOOK_FILES } from './zip-fixture';

let root: string;
let input: string;
let output: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'documents-'));
    input = join(root, 'in');
    output = join(root, 'out');
    mkdirSync(input);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A fake of textutil and osascript. It records the calls. */
function fakeTools(options: { word?: string; pdfTexts?: string[]; pdfError?: string } = {}) {
    const calls: { file: string; args: readonly string[] }[] = [];
    const run: RunTool = async (file, args) => {
        calls.push({ file, args });
        if (file.endsWith('textutil')) return options.word ?? '';
        if (options.pdfError) return JSON.stringify({ error: options.pdfError });
        const command = args[4];
        if (command === 'text') return JSON.stringify({ pages: options.pdfTexts?.length ?? 0, texts: options.pdfTexts ?? [] });
        const folder = args[6];
        const count = Math.min(Number(args[7]), options.pdfTexts?.length ?? 0);
        const files = Array.from({ length: count }, (_, index) => {
            const file = join(folder, `page-${index + 1}.png`);
            writeFileSync(file, `png ${index + 1}`);
            return file;
        });
        return JSON.stringify({ pages: options.pdfTexts?.length ?? 0, files });
    };
    return { run, calls };
}

function converter(run: RunTool, platform: NodeJS.Platform = 'darwin', now?: () => number) {
    return new DocumentConverter({ folder: output, run, platform, now });
}

function file(name: string, content: string | Buffer): string {
    const path = join(input, name);
    writeFileSync(path, content);
    return path;
}

describe('DocumentConverter', () => {
    it('converts a Word file with textutil', async () => {
        const tools = fakeTools({ word: 'Hello\r\nWorld' });
        const result = await converter(tools.run).convert(file('notes.docx', 'binary'));
        expect(tools.calls[0]).toEqual({ file: '/usr/bin/textutil', args: ['-convert', 'txt', '-stdout', join(input, 'notes.docx')] });
        expect(result.ok).toBe(true);
        if (!result.ok || result.document.kind !== 'text') throw new Error('expected text');
        expect(result.document).toMatchObject({ name: 'notes.docx', chars: 11, truncated: false });
        expect(result.document.textPath.startsWith(output)).toBe(true);
        expect(result.document.textPath.endsWith('notes.docx.txt')).toBe(true);
        expect(readFileSync(result.document.textPath, 'utf8')).toBe('Hello\nWorld');
    });

    it('reads a CSV file without a tool', async () => {
        const tools = fakeTools();
        const result = await converter(tools.run, 'linux').convert(file('table.csv', 'a,b\n1,2'));
        expect(tools.calls).toEqual([]);
        if (!result.ok || result.document.kind !== 'text') throw new Error('expected text');
        expect(readFileSync(result.document.textPath, 'utf8')).toBe('a,b\n1,2');
    });

    it('converts an Excel workbook to CSV text', async () => {
        const result = await converter(fakeTools().run).convert(file('book.xlsx', makeZip(WORKBOOK_FILES)));
        if (!result.ok || result.document.kind !== 'text') throw new Error('expected text');
        expect(readFileSync(result.document.textPath, 'utf8')).toContain('# Sheet: Sales & Costs\nRegion,Total');
    });

    it('cuts a long text and says so', async () => {
        const result = await converter(fakeTools().run).convert(file('big.txt', 'x'.repeat(MAX_DOCUMENT_CHARS + 10)));
        if (!result.ok || result.document.kind !== 'text') throw new Error('expected text');
        expect(result.document).toMatchObject({ chars: MAX_DOCUMENT_CHARS, truncated: true });
        expect(readFileSync(result.document.textPath, 'utf8')).toHaveLength(MAX_DOCUMENT_CHARS);
    });

    it('converts a PDF with text to a text file with page headings', async () => {
        const tools = fakeTools({ pdfTexts: ['The first page has text.', 'The second page has text.'] });
        const result = await converter(tools.run).convert(file('report.pdf', '%PDF'));
        expect(tools.calls).toHaveLength(1);
        expect(tools.calls[0].file).toBe('/usr/bin/osascript');
        if (!result.ok || result.document.kind !== 'text') throw new Error('expected text');
        expect(result.document.pages).toBe(2);
        expect(readFileSync(result.document.textPath, 'utf8')).toBe('--- Page 1 ---\nThe first page has text.\n\n--- Page 2 ---\nThe second page has text.');
    });

    it('renders the first pages of a PDF without text as images', async () => {
        const tools = fakeTools({ pdfTexts: Array.from({ length: MAX_PDF_IMAGE_PAGES + 2 }, () => ' ') });
        const result = await converter(tools.run).convert(file('scan.pdf', '%PDF'));
        expect(tools.calls.map(call => call.args[4])).toEqual(['text', 'images']);
        if (!result.ok || result.document.kind !== 'images') throw new Error('expected images');
        expect(result.document.images).toHaveLength(MAX_PDF_IMAGE_PAGES);
        expect(result.document.images[0]).toBe(`data:image/png;base64,${Buffer.from('png 1').toString('base64')}`);
        expect(result.document).toMatchObject({ pages: MAX_PDF_IMAGE_PAGES + 2, truncated: true });
    });

    it('explains a locked PDF', async () => {
        const result = await converter(fakeTools({ pdfError: 'locked' }).run).convert(file('secret.pdf', '%PDF'));
        expect(result).toEqual({ ok: false, error: '"secret.pdf" has a password. Remove the password, then attach the PDF again.' });
    });

    it('rejects a file type that is not supported', async () => {
        const result = await converter(fakeTools().run).convert(file('deck.key', 'x'));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('cannot attach "deck.key"');
    });

    it('rejects a missing file', async () => {
        const result = await converter(fakeTools().run).convert(join(input, 'gone.pdf'));
        expect(result).toEqual({ ok: false, error: 'ShipWarden cannot read "gone.pdf". The file is not found.' });
    });

    it('converts Word and PDF files only on macOS', async () => {
        const result = await converter(fakeTools().run, 'linux').convert(file('notes.docx', 'x'));
        expect(result).toEqual({ ok: false, error: 'ShipWarden converts "notes.docx" only on macOS.' });
    });

    it('shows the error of a damaged workbook', async () => {
        const result = await converter(fakeTools().run).convert(file('bad.xlsx', 'not a zip'));
        expect(result).toEqual({ ok: false, error: 'ShipWarden cannot convert "bad.xlsx". The file is not a valid Excel workbook.' });
    });

    it('removes the folders of old conversions', async () => {
        const old = join(output, 'old');
        const recent = join(output, 'recent');
        mkdirSync(old, { recursive: true });
        mkdirSync(recent);
        const now = Date.now();
        const eightDays = (now - 8 * 24 * 60 * 60 * 1000) / 1000;
        utimesSync(old, eightDays, eightDays);
        await converter(fakeTools().run, 'darwin', () => now).removeOld();
        expect(existsSync(old)).toBe(false);
        expect(existsSync(recent)).toBe(true);
    });
});

describe('PDF text', () => {
    it('finds a PDF without a text layer', () => {
        expect(pdfHasNoText(['', ' \n '])).toBe(true);
        expect(pdfHasNoText(['12'])).toBe(true);
        expect(pdfHasNoText(['This page has enough text.'])).toBe(false);
        expect(pdfHasNoText([])).toBe(true);
    });

    it('writes a single page without a heading', () => {
        expect(pdfPagesToText(['  One page  '])).toBe('One page');
    });
});
