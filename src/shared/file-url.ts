/**
 * The custom protocol that serves files of a worktree to the viewers (images, PDF, audio and video).
 * A URL has the form `shipwarden-file://root/<root as hex>/<path relative to the root>`.
 * The root is hex text, because a standard URL changes the case of the host and removes "." and ".." segments.
 */
export const FILE_SCHEME = 'shipwarden-file';
const HOST = 'root';

function toHex(text: string): string {
    return [...new TextEncoder().encode(text)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): string | undefined {
    if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
        return undefined;
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index++) {
        bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return new TextDecoder().decode(bytes);
}

/**
 * Returns the protocol URL of a file in a worktree.
 * `version` goes into the query, so the page loads the file again after a change.
 */
export function fileUrl(root: string, path: string, version?: number): string {
    const segments = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return `${FILE_SCHEME}://${HOST}/${toHex(root)}/${segments}${version ? `?v=${version}` : ''}`;
}

/** Reads the root and the relative path from a protocol URL. Returns undefined when the URL is not valid. */
export function parseFileUrl(url: string): { root: string; path: string } | undefined {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    if (parsed.protocol !== `${FILE_SCHEME}:` || parsed.hostname.toLowerCase() !== HOST) {
        return undefined;
    }
    const [hex, ...rest] = parsed.pathname.replace(/^\/+/, '').split('/');
    const root = fromHex(hex ?? '');
    if (!root || rest.length === 0) {
        return undefined;
    }
    let segments: string[];
    try {
        segments = rest.map(decodeURIComponent);
    } catch {
        return undefined;
    }
    // A decoded segment must not add a separator or go up a folder.
    if (
        segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes('\0'))
    ) {
        return undefined;
    }
    return { root, path: segments.join('/') };
}

/**
 * Resolves a link of a Markdown file against the folder of that file.
 * Returns the path relative to the worktree root, or undefined for these links:
 * - A link with a scheme (`https:`, `data:`, `mailto:`) or a link that starts with "//".
 * - A link to an anchor in the same file ("#name").
 * - A link that goes outside the worktree root.
 * A link that starts with "/" is relative to the worktree root, as on GitHub.
 */
export function resolveRelativeLink(markdownPath: string, href: string): string | undefined {
    const value = href.trim();
    if (!value || value.startsWith('#') || value.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
        return undefined;
    }
    const withoutSuffix = value.replace(/[?#].*$/, '');
    if (!withoutSuffix) {
        return undefined;
    }
    let decoded: string;
    try {
        decoded = decodeURIComponent(withoutSuffix);
    } catch {
        decoded = withoutSuffix;
    }
    const folder = markdownPath.includes('/') ? markdownPath.slice(0, markdownPath.lastIndexOf('/')).split('/') : [];
    const parts = decoded.startsWith('/') ? [] : [...folder];
    for (const segment of decoded.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (parts.length === 0) return undefined;
            parts.pop();
        } else {
            parts.push(segment);
        }
    }
    return parts.length > 0 ? parts.join('/') : undefined;
}

/** A byte range of a file. Both ends are included. */
export interface ByteRange {
    start: number;
    end: number;
}

/**
 * Reads an HTTP Range header for a file of the given size.
 * Returns undefined when there is no header or the header has more than one range (then the full file goes).
 * Returns 'invalid' when the range is not in the file (HTTP 416).
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange | 'invalid' | undefined {
    if (!header) return undefined;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) {
        return header.includes(',') ? undefined : 'invalid';
    }
    const [, first, last] = match;
    if (!first && !last) return 'invalid';
    if (!first) {
        // "bytes=-500" is the last 500 bytes.
        const length = Number(last);
        if (length === 0 || size === 0) return 'invalid';
        return { start: Math.max(0, size - length), end: size - 1 };
    }
    const start = Number(first);
    const end = last ? Math.min(Number(last), size - 1) : size - 1;
    if (start >= size || end < start) return 'invalid';
    return { start, end };
}
