/**
 * The kind of view that shows a file.
 * - `text`: the Monaco editor.
 * - `markdown`: the Monaco editor and a rendered preview.
 * - `image`, `pdf`, `audio`, `video`: a viewer that gets the file from the `shipwarden-file:` protocol.
 * - `binary`: a panel that tells the user that ShipWarden cannot show the file.
 */
export type FileKind = 'text' | 'markdown' | 'image' | 'pdf' | 'audio' | 'video' | 'binary';

/** Facts about a file that the main process reads before the page opens a view. */
export interface FileInfo {
    /** The size in bytes. */
    size: number;
    /** The kind from the extension. When the extension is not known, the kind from the first bytes. */
    kind: FileKind;
}

/** The editor does not open text files that are larger than this limit. */
export const MAX_TEXT_FILE_SIZE = 5 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    avif: 'image/avif',
    pdf: 'application/pdf',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    flac: 'audio/flac',
    opus: 'audio/ogg',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    ogv: 'video/ogg',
    mov: 'video/quicktime'
};

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx']);

/** Extensions of files that are always binary. ShipWarden does not open them in the editor. */
const BINARY_EXTENSIONS = new Set([
    'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'jar', 'war', 'dmg', 'iso', 'pkg',
    'exe', 'dll', 'so', 'dylib', 'o', 'a', 'lib', 'bin', 'class', 'wasm', 'node', 'pyc',
    'ttf', 'otf', 'woff', 'woff2', 'eot',
    'psd', 'ai', 'sketch', 'fig', 'tif', 'tiff', 'heic', 'icns',
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'numbers', 'pages',
    'sqlite', 'db', 'avi', 'mkv', 'wmv'
]);

/** Returns the extension in lower case, without the dot. Returns an empty string when the name has no extension. */
export function extensionOf(path: string): string {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Returns the MIME type of a file that a viewer can show. Returns undefined for other files. */
export function mimeTypeOf(path: string): string | undefined {
    return MIME_TYPES[extensionOf(path)];
}

/**
 * Returns the kind of a file from its extension. Returns undefined when the extension does not tell the kind.
 * Then the first bytes of the file must tell the kind (`sniffKind`).
 */
export function kindFromExtension(path: string): FileKind | undefined {
    const extension = extensionOf(path);
    if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
    if (BINARY_EXTENSIONS.has(extension)) return 'binary';
    const mime = MIME_TYPES[extension];
    if (!mime) return undefined;
    if (mime === 'application/pdf') return 'pdf';
    return mime.split('/')[0] as 'image' | 'audio' | 'video';
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
    return bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(text: string): number[] {
    return [...text].map(character => character.charCodeAt(0));
}

/**
 * Returns the kind of a file from its first bytes. ShipWarden uses this for files with no known extension.
 * A file with a NUL byte in the first 8000 bytes is binary (git uses the same test).
 */
export function sniffKind(bytes: Uint8Array): FileKind {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image';
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image';
    if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image';
    if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image';
    if (startsWith(bytes, ascii('%PDF-'))) return 'pdf';
    const end = Math.min(bytes.length, 8000);
    for (let index = 0; index < end; index++) {
        if (bytes[index] === 0) return 'binary';
    }
    return 'text';
}

/**
 * Returns the MIME type from the first bytes of a file. The file protocol uses it for a file with no known extension.
 * Returns undefined when the bytes do not match a known image or PDF signature.
 */
export function sniffMimeType(bytes: Uint8Array): string | undefined {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (startsWith(bytes, ascii('GIF8'))) return 'image/gif';
    if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
    if (startsWith(bytes, ascii('%PDF-'))) return 'application/pdf';
    return undefined;
}

/** True for the kinds that the page shows through the `shipwarden-file:` protocol. */
export function isMediaKind(kind: FileKind): kind is 'image' | 'pdf' | 'audio' | 'video' {
    return kind === 'image' || kind === 'pdf' || kind === 'audio' || kind === 'video';
}

/** Formats a size in bytes for people, for example "1.4 MB". */
export function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
