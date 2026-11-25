import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { basename, join } from 'path';
import {
    capText,
    type ConvertedDocument,
    type DocumentConversion,
    type DocumentKind,
    documentKindOf,
    MAX_DOCUMENT_BYTES,
    MAX_PDF_IMAGE_PAGES,
    unsupportedFileText
} from '@shared/documents';
import { PDF_SCRIPT } from './pdf-script';
import { readXlsx, sheetsToText } from './xlsx';

/** A PDF with fewer letters and digits than this on each page (on average) has no text layer. */
const MIN_PDF_CHARS_PER_PAGE = 16;

/** The maximum time of one conversion tool (milliseconds). */
const TOOL_TIMEOUT_MS = 60_000;

/** ShipWarden removes the converted files after this time (milliseconds). */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Runs a program and returns its stdout. */
export type RunTool = (file: string, args: readonly string[]) => Promise<string>;

const runTool: RunTool = (file, args) =>
    new Promise((resolve, reject) => {
        execFile(file, [...args], { timeout: TOOL_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
            if (error) reject(new Error(stderr.trim() || error.message));
            else resolve(stdout);
        });
    });

export interface DocumentConverterOptions {
    /** The folder for the converted files. Each conversion gets its own subfolder. */
    folder: string;
    platform?: NodeJS.Platform;
    /** Runs textutil and osascript. A test gives a fake. */
    run?: RunTool;
    now?: () => number;
}

/** An error with a text for the user. */
class ConversionError extends Error {}

/** The result of a PDF conversion with the PDFKit script. */
interface PdfTextResult {
    error?: string;
    pages?: number;
    texts?: string[];
    files?: string[];
}

/** Returns true when the page texts of a PDF have too few letters and digits for a text layer. */
export function pdfHasNoText(texts: readonly string[]): boolean {
    const chars = texts.join('').replace(/[^\p{L}\p{N}]/gu, '').length;
    return chars < MIN_PDF_CHARS_PER_PAGE * Math.max(1, texts.length);
}

/** Makes one text from the page texts of a PDF, with a heading line for each page. */
export function pdfPagesToText(texts: readonly string[]): string {
    if (texts.length === 1) return texts[0].trim();
    return texts.map((text, index) => `--- Page ${index + 1} ---\n${text.trim()}`).join('\n\n');
}

/**
 * Converts documents for the chat view. A document becomes a text file in its own folder under `folder`, or page
 * images for a PDF without text. The agent reads the text file, so a long document does not go into the terminal.
 */
export class DocumentConverter {
    private readonly options: DocumentConverterOptions;

    constructor(options: DocumentConverterOptions) {
        this.options = options;
    }

    private get run(): RunTool {
        return this.options.run ?? runTool;
    }

    /** Converts one file. Returns an error text for the user when the conversion fails. */
    async convert(path: string): Promise<DocumentConversion> {
        const name = basename(path);
        const kind = documentKindOf(name);
        if (!kind) return { ok: false, error: unsupportedFileText(name) };
        try {
            const stat = await fs.stat(path).catch(() => undefined);
            if (!stat?.isFile()) throw new ConversionError(`ShipWarden cannot read "${name}". The file is not found.`);
            if (stat.size > MAX_DOCUMENT_BYTES) throw new ConversionError(`"${name}" is too large. The maximum size is 50 MB.`);
            const needsMac = kind === 'word' || kind === 'pdf';
            if (needsMac && (this.options.platform ?? process.platform) !== 'darwin') {
                throw new ConversionError(`ShipWarden converts "${name}" only on macOS.`);
            }
            void this.removeOld();
            const folder = join(this.options.folder, randomUUID());
            await fs.mkdir(folder, { recursive: true });
            const document = await this.convertKind(kind, path, name, folder);
            return { ok: true, document };
        } catch (error) {
            if (error instanceof ConversionError) return { ok: false, error: error.message };
            return { ok: false, error: `ShipWarden cannot convert "${name}". ${error instanceof Error ? error.message : String(error)}` };
        }
    }

    private async convertKind(kind: DocumentKind, path: string, name: string, folder: string): Promise<ConvertedDocument> {
        if (kind === 'pdf') return this.convertPdf(path, name, folder);
        let text: string;
        if (kind === 'word') text = await this.run('/usr/bin/textutil', ['-convert', 'txt', '-stdout', path]);
        else if (kind === 'spreadsheet') text = sheetsToText(readXlsx(await fs.readFile(path)));
        else text = await fs.readFile(path, 'utf8');
        return this.writeText(text, name, folder);
    }

    private async convertPdf(path: string, name: string, folder: string): Promise<ConvertedDocument> {
        const result = await this.runPdfScript(['text', path], name);
        const texts = result.texts ?? [];
        const pages = result.pages ?? texts.length;
        if (!pdfHasNoText(texts)) return this.writeText(pdfPagesToText(texts), name, folder, pages);
        // A scanned PDF has no text layer. The agent gets the first pages as images.
        const rendered = await this.runPdfScript(['images', path, folder, String(MAX_PDF_IMAGE_PAGES)], name);
        const images = await Promise.all((rendered.files ?? []).map(async file => `data:image/png;base64,${(await fs.readFile(file)).toString('base64')}`));
        if (images.length === 0) throw new ConversionError(`"${name}" has no pages.`);
        return { kind: 'images', name, images, pages, truncated: pages > images.length };
    }

    private async runPdfScript(args: readonly string[], name: string): Promise<PdfTextResult> {
        const output = await this.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PDF_SCRIPT, ...args]);
        let result: PdfTextResult;
        try {
            result = JSON.parse(output) as PdfTextResult;
        } catch {
            throw new ConversionError(`ShipWarden cannot read the PDF "${name}".`);
        }
        if (result.error === 'locked') throw new ConversionError(`"${name}" has a password. Remove the password, then attach the PDF again.`);
        if (result.error) throw new ConversionError(`ShipWarden cannot open the PDF "${name}". The file can be damaged.`);
        return result;
    }

    /** Writes the text of a document to "<name>.txt" in its folder, cut to the maximum length. */
    private async writeText(text: string, name: string, folder: string, pages?: number): Promise<ConvertedDocument> {
        const capped = capText(text.replace(/\r\n?/g, '\n'));
        const textPath = join(folder, `${name}.txt`);
        await fs.writeFile(textPath, capped.text, 'utf8');
        return { kind: 'text', name, textPath, chars: capped.text.length, truncated: capped.truncated, ...(pages !== undefined ? { pages } : {}) };
    }

    /** Removes the folders of conversions that are older than 7 days. Errors do not matter. */
    async removeOld(): Promise<void> {
        const now = (this.options.now ?? Date.now)();
        const names = await fs.readdir(this.options.folder).catch(() => [] as string[]);
        await Promise.all(
            names.map(async entry => {
                const path = join(this.options.folder, entry);
                const stat = await fs.stat(path).catch(() => undefined);
                if (stat && now - stat.mtimeMs > KEEP_MS) await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
            })
        );
    }
}
