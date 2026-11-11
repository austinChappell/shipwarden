import { HTTP_METHODS, HTTP_TIMEOUT_DEFAULT, HTTP_TIMEOUT_MAX, type HttpMethod } from '@shared/automations';
import type { HttpResponse } from '@shared/automation-templates';
import { networkErrorDetail } from '@shared/network';

/** The request of an "HTTP request" action, with the variables and the secrets already in it. */
export interface HttpRequest {
    method: HttpMethod;
    url: string;
    headers: Record<string, string>;
    body?: string;
    timeoutSeconds?: number;
}

/** The answer keeps at most this much of the body. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Checks a request from the page. Throws an error with a message for the user. */
export function httpRequestOf(value: unknown): HttpRequest {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const method = HTTP_METHODS.find(item => item === raw.method);
    if (!method) throw new Error(`The HTTP method "${String(raw.method)}" is not known.`);
    if (typeof raw.url !== 'string') throw new Error('The HTTP request has no web address.');
    let url: URL;
    try {
        url = new URL(raw.url.trim());
    } catch {
        throw new Error(`"${raw.url}" is not a valid web address.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The web address must start with http:// or https://.');
    const headers: Record<string, string> = {};
    if (raw.headers && typeof raw.headers === 'object') {
        for (const [name, headerValue] of Object.entries(raw.headers as Record<string, unknown>)) {
            if (typeof headerValue === 'string') headers[name] = headerValue;
        }
    }
    const timeout = typeof raw.timeoutSeconds === 'number' && Number.isFinite(raw.timeoutSeconds) ? raw.timeoutSeconds : HTTP_TIMEOUT_DEFAULT;
    return {
        method,
        url: url.toString(),
        headers,
        ...(typeof raw.body === 'string' && method !== 'GET' ? { body: raw.body } : {}),
        timeoutSeconds: Math.min(HTTP_TIMEOUT_MAX, Math.max(1, timeout))
    };
}

/** Reads the body up to MAX_RESPONSE_BYTES. Then it stops the download. */
async function readBody(response: Response): Promise<{ body: string; truncated: boolean }> {
    if (!response.body) return { body: '', truncated: false };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const room = MAX_RESPONSE_BYTES - size;
        if (value.byteLength > room) {
            chunks.push(value.subarray(0, room));
            truncated = true;
            await reader.cancel().catch(() => undefined);
            break;
        }
        chunks.push(value);
        size += value.byteLength;
    }
    return { body: Buffer.concat(chunks).toString('utf8'), truncated };
}

/**
 * Sends the request of an "HTTP request" action. The main process sends it, so the page has no CORS limits, and the
 * request uses the trusted certificates of Settings › Network. `ready` resolves when those certificates apply.
 */
export async function sendHttpRequest(value: unknown, ready: Promise<void>, fetcher: typeof fetch = fetch): Promise<HttpResponse> {
    const request = httpRequestOf(value);
    await ready;
    let response: Response;
    try {
        response = await fetcher(request.url, {
            method: request.method,
            headers: request.headers,
            ...(request.body !== undefined ? { body: request.body } : {}),
            redirect: 'follow',
            signal: AbortSignal.timeout((request.timeoutSeconds ?? HTTP_TIMEOUT_DEFAULT) * 1000)
        });
    } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
            throw new Error(`${request.method} ${new URL(request.url).host} did not answer in ${request.timeoutSeconds} seconds.`);
        }
        throw new Error(`${request.method} ${new URL(request.url).host} failed: ${networkErrorDetail(error)}`);
    }
    const { body, truncated } = await readBody(response);
    const contentType = response.headers.get('content-type') ?? undefined;
    return { status: response.status, statusText: response.statusText, body, truncated, ...(contentType ? { contentType } : {}) };
}
