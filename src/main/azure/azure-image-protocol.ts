import { sniffMimeType } from '@shared/file-types';
import { parseAzureImageUrl } from '@shared/azure-image-url';

/** Gets a file from Azure DevOps with the token of the provider of the organization. */
export type AzureFileFetch = (organization: string, url: string, accept: string) => Promise<Response>;

interface CachedImage {
    type: string;
    bytes: Uint8Array;
}

/** The handler keeps this number of images in memory. A page that shows the description again does not send a new request. */
const CACHE_SIZE = 100;
/** The handler does not keep an image that is larger than this size in memory. */
const MAX_CACHED_BYTES = 5 * 1024 * 1024;
/** The CSP of an SVG image. An SVG in an <img> cannot run scripts. This header also stops scripts when a frame opens the image. */
const SVG_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

function failure(status: number, message: string): Response {
    return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/** Returns the image type of the response. Returns undefined when the response is not an image. */
function imageType(header: string | null, bytes: Uint8Array): string | undefined {
    const type = (header ?? '').split(';')[0]!.trim().toLowerCase();
    if (type.startsWith('image/')) return type;
    // Azure DevOps can send an attachment as "application/octet-stream". Then the first bytes tell the type.
    const sniffed = sniffMimeType(bytes);
    return sniffed?.startsWith('image/') ? sniffed : undefined;
}

/**
 * Makes the handler of the `shipwarden-azure-image:` protocol. The handler gets an image from Azure DevOps with the token.
 * It refuses these requests:
 * - A URL that is not on an Azure DevOps host, or that has no "/_apis/" in the path.
 * - A response that is not an image.
 */
export function createAzureImageHandler(fetchFile: AzureFileFetch): (request: Request) => Promise<Response> {
    const cache = new Map<string, Promise<CachedImage>>();

    const load = (organization: string, url: string): Promise<CachedImage> => {
        const cached = cache.get(url);
        if (cached) {
            // Move the image to the end, so that the oldest images go first.
            cache.delete(url);
            cache.set(url, cached);
            return cached;
        }
        const next = (async () => {
            const response = await fetchFile(organization, url, 'image/*');
            const bytes = new Uint8Array(await response.arrayBuffer());
            const type = imageType(response.headers.get('content-type'), bytes);
            if (!type) {
                throw new Error('The Azure DevOps file is not an image.');
            }
            return { type, bytes };
        })();
        cache.set(url, next);
        next.then(
            image => {
                if (image.bytes.byteLength > MAX_CACHED_BYTES && cache.get(url) === next) cache.delete(url);
            },
            () => {
                // Do not keep a failure. The next request tries again, for example after the user adds a token.
                if (cache.get(url) === next) cache.delete(url);
            }
        );
        while (cache.size > CACHE_SIZE) {
            cache.delete(cache.keys().next().value!);
        }
        return next;
    };

    return async request => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return failure(405, 'The Azure DevOps image protocol accepts only GET and HEAD requests.');
        }
        const target = parseAzureImageUrl(request.url);
        if (!target) {
            return failure(400, 'The Azure DevOps image URL is not valid.');
        }
        let image: CachedImage;
        try {
            image = await load(target.organization, target.url);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[azure] The image did not load: ${message}`);
            return failure(502, message);
        }
        const headers: Record<string, string> = {
            'Content-Type': image.type,
            'Content-Length': String(image.bytes.byteLength),
            'X-Content-Type-Options': 'nosniff'
        };
        if (image.type === 'image/svg+xml') {
            headers['Content-Security-Policy'] = SVG_POLICY;
        }
        return new Response(request.method === 'HEAD' ? null : image.bytes, { status: 200, headers });
    };
}
