/**
 * Document attachments in the chat view. The main process converts a PDF, Word, or spreadsheet file to a text file
 * (or to page images, for a PDF without text). The agent gets the path of the text file in the prompt, because a long
 * text must not go into the terminal. See docs/document-attachments.md.
 */

/** The kinds of documents. Each kind has its own converter in the main process. */
export type DocumentKind = 'word' | 'pdf' | 'spreadsheet' | 'text';

/** The file extensions that the chat can attach as a document, and their kinds. The keys are lowercase. */
export const DOCUMENT_EXTENSIONS: Readonly<Record<string, DocumentKind>> = {
    docx: 'word',
    doc: 'word',
    rtf: 'word',
    odt: 'word',
    html: 'word',
    htm: 'word',
    pdf: 'pdf',
    xlsx: 'spreadsheet',
    xlsm: 'spreadsheet',
    csv: 'text',
    tsv: 'text',
    txt: 'text',
    md: 'text'
};

/** The image extensions that the chat attaches as images, not as documents. */
export const IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

/** The largest document file that ShipWarden converts (bytes). */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

/** The maximum length of the text file of one document (characters). ShipWarden cuts a longer text. */
export const MAX_DOCUMENT_CHARS = 500_000;

/** The maximum number of page images of a PDF without text. */
export const MAX_PDF_IMAGE_PAGES = 5;

/** The maximum number of documents in one prompt. */
export const MAX_DOCUMENTS = 10;

/** The text of the error for a file type that the chat cannot attach. */
export const SUPPORTED_TYPES_TEXT = 'PDF, Word (.docx, .doc), RTF, OpenDocument text (.odt), HTML, Excel (.xlsx), CSV, TSV, text, and Markdown';

/** Returns the lowercase extension of a file name without the dot, or an empty string. */
export function extensionOf(name: string): string {
    const base = name.slice(name.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Returns the document kind of a file name, or undefined when the chat cannot attach the file as a document. */
export function documentKindOf(name: string): DocumentKind | undefined {
    const extension = extensionOf(name);
    return Object.hasOwn(DOCUMENT_EXTENSIONS, extension) ? DOCUMENT_EXTENSIONS[extension] : undefined;
}

/** Returns true for an image file name that the chat attaches as an image. */
export function isImageFileName(name: string): boolean {
    return IMAGE_EXTENSIONS.includes(extensionOf(name));
}

/**
 * Returns how the chat attaches a file: as an image, as a document, or not at all. `mimeType` is the type that the
 * browser gives (it can be empty).
 */
export function attachmentKindOf(name: string, mimeType = ''): 'image' | 'document' | 'unsupported' {
    if (documentKindOf(name)) return 'document';
    if (isImageFileName(name) || (mimeType.startsWith('image/') && !extensionOf(name))) return 'image';
    return 'unsupported';
}

/** Returns the error text for a file that the chat cannot attach. */
export function unsupportedFileText(name: string): string {
    return `ShipWarden cannot attach "${name}". Attach a ${SUPPORTED_TYPES_TEXT} file, or an image.`;
}

/** Cuts a text to `max` characters. `truncated` is true when the text was longer. */
export function capText(text: string, max = MAX_DOCUMENT_CHARS): { text: string; truncated: boolean } {
    if (text.length <= max) return { text, truncated: false };
    // Do not cut a surrogate pair into two halves.
    let end = max;
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    return { text: text.slice(0, end), truncated: true };
}

/** A converted document, from the main process. */
export type ConvertedDocument =
    | {
          kind: 'text';
          /** The file name of the document, for example "report.pdf". */
          name: string;
          /** The absolute path of the text file for the agent. */
          textPath: string;
          /** The number of characters in the text file. */
          chars: number;
          /** True when ShipWarden cut the text to MAX_DOCUMENT_CHARS. */
          truncated: boolean;
          /** The number of pages of a PDF. */
          pages?: number;
      }
    | {
          kind: 'images';
          name: string;
          /** The page images as PNG data URLs. The chat gives them to the agent as image attachments. */
          images: string[];
          /** The number of pages of the PDF. */
          pages: number;
          /** True when the PDF has more pages than MAX_PDF_IMAGE_PAGES. */
          truncated: boolean;
      };

/** The result of a conversion. A failure has an error text for the user. */
export type DocumentConversion = { ok: true; document: ConvertedDocument } | { ok: false; error: string };

/** Formats a number with thousands separators, for example "500,000". */
function formatCount(value: number): string {
    return value.toLocaleString('en-US');
}

/** Returns the short note for the chip of a cut document, or undefined when the document is complete. */
export function truncationNote(document: ConvertedDocument): string | undefined {
    if (!document.truncated) return undefined;
    if (document.kind === 'images') return `The agent gets the first ${document.images.length} of ${document.pages} pages as images.`;
    return `The document is long. The agent gets the first ${formatCount(document.chars)} characters.`;
}

/** Returns the line of the prompt for one document. */
function documentLine(document: ConvertedDocument): string {
    if (document.kind === 'images') {
        const count = document.images.length;
        const pages = document.truncated ? `the first ${count} of ${document.pages} pages` : `${count === 1 ? 'the page' : `all ${count} pages`}`;
        return `- ${document.name}: the PDF has no text. This prompt has ${pages} as images.`;
    }
    const parts: string[] = [];
    if (document.pages !== undefined) parts.push(document.pages === 1 ? '1 page' : `${document.pages} pages`);
    if (document.truncated) parts.push(`cut to the first ${formatCount(document.chars)} characters`);
    const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    return `- ${document.name}${detail}: ${document.textPath}`;
}

/**
 * Returns the prompt for the agent: a list of the attached documents, then the text of the user. A document with text
 * has the path of its text file. The agent reads the file itself, so a long document does not go into the terminal.
 */
export function documentPrompt(documents: readonly ConvertedDocument[], text: string): string {
    if (documents.length === 0) return text;
    const hasFiles = documents.some(document => document.kind === 'text');
    const intro = hasFiles ? 'I attached documents. ShipWarden converted each document to a text file. Read the text files:' : 'I attached documents:';
    const list = [intro, ...documents.map(documentLine)].join('\n');
    return text ? `${list}\n\n${text}` : list;
}
