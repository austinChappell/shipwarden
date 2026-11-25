import { inflateRawSync } from 'zlib';

/**
 * A small reader for Excel workbooks (.xlsx). An .xlsx file is a zip file of XML files. This reader reads the zip
 * directory, the workbook, the shared strings, and each sheet, and makes CSV text. It does not read formats, dates,
 * formulas, or charts: a cell gives its stored value. A date shows as its serial number.
 */

/** The largest XML file in a workbook that the reader inflates (bytes). This stops a "zip bomb". */
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;

/** An error with a text for the user. */
export class XlsxError extends Error {}

interface ZipEntry {
    method: number;
    compressedSize: number;
    size: number;
    localOffset: number;
}

/** Reads the central directory of a zip file. Returns the entries by name. Zip64 files are not supported. */
export function readZipDirectory(data: Buffer): Map<string, ZipEntry> {
    // The end record is at the end of the file, before a comment of up to 65,535 bytes.
    let end = -1;
    for (let offset = data.length - 22; offset >= Math.max(0, data.length - 22 - 0xffff); offset--) {
        if (data.readUInt32LE(offset) === 0x06054b50) {
            end = offset;
            break;
        }
    }
    if (end < 0) throw new XlsxError('The file is not a valid Excel workbook.');
    const count = data.readUInt16LE(end + 10);
    let offset = data.readUInt32LE(end + 16);
    if (offset === 0xffffffff) throw new XlsxError('ShipWarden cannot read Excel workbooks larger than 4 GB.');
    const entries = new Map<string, ZipEntry>();
    for (let index = 0; index < count; index++) {
        if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) throw new XlsxError('The Excel workbook is damaged.');
        const nameLength = data.readUInt16LE(offset + 28);
        const extraLength = data.readUInt16LE(offset + 30);
        const commentLength = data.readUInt16LE(offset + 32);
        const name = data.toString('utf8', offset + 46, offset + 46 + nameLength);
        entries.set(name, {
            method: data.readUInt16LE(offset + 10),
            compressedSize: data.readUInt32LE(offset + 20),
            size: data.readUInt32LE(offset + 24),
            localOffset: data.readUInt32LE(offset + 42)
        });
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

/** Returns the content of one zip entry as text, or undefined when the entry does not exist. */
export function readZipText(data: Buffer, entries: Map<string, ZipEntry>, name: string): string | undefined {
    const entry = entries.get(name);
    if (!entry) return undefined;
    const local = entry.localOffset;
    if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) throw new XlsxError('The Excel workbook is damaged.');
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const raw = data.subarray(start, start + entry.compressedSize);
    if (entry.size > MAX_ENTRY_BYTES) throw new XlsxError('The Excel workbook is too large.');
    if (entry.method === 0) return raw.toString('utf8');
    if (entry.method !== 8) throw new XlsxError('The Excel workbook uses a compression that ShipWarden cannot read.');
    try {
        return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }).toString('utf8');
    } catch {
        throw new XlsxError('The Excel workbook is damaged.');
    }
}

/** Changes the XML entities of a text to their characters. */
export function decodeXml(text: string): string {
    return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_match, entity: string) => {
        if (entity === 'lt') return '<';
        if (entity === 'gt') return '>';
        if (entity === 'amp') return '&';
        if (entity === 'quot') return '"';
        if (entity === 'apos') return "'";
        const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
        return code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

/**
 * Removes the namespace prefixes of the element names, for example "<x:sheet>" becomes "<sheet>". Some programs (the
 * Open XML SDK) write the SpreadsheetML elements with a prefix. The attribute names keep their prefixes.
 */
export function stripElementPrefixes(xml: string): string {
    return xml.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1');
}

/** Returns the value of an XML attribute in a tag text, or undefined. */
function attribute(tag: string, name: string): string | undefined {
    const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag);
    return match ? decodeXml(match[1]) : undefined;
}

/** Returns the text of the <t> elements in an XML part. Phonetic runs (<rPh>) do not count. */
function textOf(xml: string): string {
    const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let text = '';
    for (const match of withoutPhonetic.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) text += decodeXml(match[1] ?? '');
    return text;
}

/** Reads the shared strings of a workbook. */
export function parseSharedStrings(xml: string): string[] {
    return [...xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map(match => textOf(match[1] ?? ''));
}

/** Returns the zero-based column of a cell reference, for example 0 for "A1" and 27 for "AB3". */
export function columnIndex(reference: string): number {
    let column = 0;
    for (const char of reference) {
        const code = char.toUpperCase().charCodeAt(0);
        if (code < 65 || code > 90) break;
        column = column * 26 + (code - 64);
    }
    return column - 1;
}

/** Returns the value of a cell for the CSV text. */
function cellValue(attributes: string, body: string, shared: readonly string[]): string {
    const type = attribute(attributes, 't');
    if (type === 'inlineStr') return textOf(body);
    const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
    if (value === undefined) return '';
    const decoded = decodeXml(value);
    if (type === 's') return shared[Number(decoded)] ?? '';
    if (type === 'b') return decoded === '1' ? 'TRUE' : 'FALSE';
    return decoded;
}

/** Quotes a CSV field when it has a comma, a quote, or a line break. */
export function csvField(value: string): string {
    return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Makes CSV lines from the XML of one sheet. Empty rows and the empty cells at the end of a row do not show. A cell
 * keeps its column, so an empty cell in the middle of a row is an empty field.
 */
export function sheetToCsv(xml: string, shared: readonly string[]): string {
    const lines: string[] = [];
    for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const fields: string[] = [];
        let next = 0;
        for (const cell of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const reference = attribute(cell[1], 'r');
            const column = reference ? columnIndex(reference) : next;
            const value = cellValue(cell[1], cell[2] ?? '', shared);
            if (column >= 0) {
                while (fields.length < column) fields.push('');
                fields[column] = csvField(value);
                next = column + 1;
            }
        }
        while (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
        if (fields.length > 0) lines.push(fields.join(','));
    }
    return lines.join('\n');
}

/** Returns the path of a relationship target in the zip, relative to the folder "xl". */
function sheetPath(target: string): string {
    if (target.startsWith('/')) return target.slice(1);
    const parts = ['xl'];
    for (const part of target.split('/')) {
        if (part === '..') parts.pop();
        else if (part !== '.') parts.push(part);
    }
    return parts.join('/');
}

/** One sheet of a workbook as CSV text. */
export interface XlsxSheet {
    name: string;
    csv: string;
}

/** Reads the sheets of an .xlsx file in their order in the workbook. */
export function readXlsx(data: Buffer): XlsxSheet[] {
    const entries = readZipDirectory(data);
    const read = (name: string) => {
        const text = readZipText(data, entries, name);
        return text === undefined ? undefined : stripElementPrefixes(text);
    };
    const workbook = read('xl/workbook.xml');
    if (workbook === undefined) throw new XlsxError('The file is not a valid Excel workbook.');
    const relations = new Map<string, string>();
    for (const match of (read('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
        const id = attribute(match[1], 'Id');
        const target = attribute(match[1], 'Target');
        if (id && target) relations.set(id, sheetPath(target));
    }
    const sharedXml = read('xl/sharedStrings.xml');
    const shared = sharedXml ? parseSharedStrings(sharedXml) : [];
    const sheets: XlsxSheet[] = [];
    for (const match of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
        const name = attribute(match[1], 'name') ?? `Sheet ${sheets.length + 1}`;
        // The prefix of the relationship namespace is usually "r", but a workbook can use another prefix.
        const id = attribute(match[1], '[\\w.-]+:id');
        const path = (id && relations.get(id)) ?? `xl/worksheets/sheet${sheets.length + 1}.xml`;
        const xml = read(path);
        // A chart sheet or a missing part has no cells.
        if (xml !== undefined) sheets.push({ name, csv: sheetToCsv(xml, shared) });
    }
    return sheets;
}

/** Makes one text from the sheets: a heading line for each sheet, then its CSV lines. */
export function sheetsToText(sheets: readonly XlsxSheet[]): string {
    return sheets.map(sheet => `# Sheet: ${sheet.name}\n${sheet.csv || '(empty)'}`).join('\n\n');
}
