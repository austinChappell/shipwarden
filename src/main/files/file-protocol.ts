import { createReadStream, promises as fs } from 'fs';
import { Readable } from 'stream';
import { isMediaKind, mimeTypeOf, sniffMimeType } from '@shared/file-types';
import { parseFileUrl, parseRange } from '@shared/file-url';
import { detectKind, isInside, resolveInside } from './file-service';

/**
 * Returns the root when it is a known worktree of a project.
 * Throws an error for other folders.
 */
export type KnownRootCheck = (root: string) => Promise<string>;

/** The CSP of an SVG file. An SVG in an <img> cannot run scripts. This header also stops scripts when a frame opens the file. */
const SVG_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

function failure(status: number, message: string): Response {
    return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function readStart(absolute: string): Promise<Uint8Array> {
    const handle = await fs.open(absolute, 'r');
    try {
        const buffer = Buffer.alloc(16);
        const { bytesRead } = await handle.read(buffer, 0, 16, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

/**
 * Makes the handler of the `shipwarden-file:` protocol. The handler sends images, PDF, audio and video files only.
 * It refuses these requests:
 * - A root that is not a known worktree of a project.
 * - A path outside the root, also through a symbolic link.
 * - A file of a different kind (for example source code or a key file).
 * The handler sends byte ranges, because the <video> and <audio> elements need them to seek.
 */
export function createFileProtocolHandler(knownRoot: KnownRootCheck): (request: Request) => Promise<Response> {
    return async request => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return failure(405, 'The file protocol accepts only GET and HEAD requests.');
        }
        const target = parseFileUrl(request.url);
        if (!target) {
            return failure(400, 'The file URL is not valid.');
        }
        let absolute: string;
        try {
            const root = await knownRoot(target.root);
            absolute = resolveInside(root, target.path);
            // A symbolic link in the worktree must not give access to a file outside the worktree.
            const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(absolute)]);
            if (!isInside(realRoot, realFile)) {
                return failure(403, 'The file is outside the worktree.');
            }
            absolute = realFile;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            return code === 'ENOENT' ? failure(404, 'The file does not exist.') : failure(403, 'The file is not in a known worktree.');
        }

        let size: number;
        let type: string | undefined;
        try {
            const stat = await fs.stat(absolute);
            if (!stat.isFile()) {
                return failure(404, 'The path is not a file.');
            }
            size = stat.size;
            if (!isMediaKind(await detectKind(absolute))) {
                return failure(403, 'The file protocol sends only images, PDF, audio and video files.');
            }
            type = mimeTypeOf(absolute) ?? sniffMimeType(await readStart(absolute));
        } catch {
            return failure(404, 'The file does not exist.');
        }

        const headers: Record<string, string> = {
            'Content-Type': type ?? 'application/octet-stream',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        };
        if (type === 'image/svg+xml') {
            headers['Content-Security-Policy'] = SVG_POLICY;
        }

        const range = parseRange(request.headers.get('range'), size);
        if (range === 'invalid') {
            return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
        }
        const start = range?.start ?? 0;
        const end = range?.end ?? size - 1;
        const length = size === 0 ? 0 : end - start + 1;
        headers['Content-Length'] = String(length);
        if (range) {
            headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        }
        const status = range ? 206 : 200;
        if (request.method === 'HEAD' || length === 0) {
            return new Response(null, { status, headers });
        }
        const stream = Readable.toWeb(createReadStream(absolute, { start, end })) as ReadableStream<Uint8Array>;
        return new Response(stream, { status, headers });
    };
}
