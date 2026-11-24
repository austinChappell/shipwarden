import { giteaHostOf, normalizeGiteaUrl } from '@shared/gitea';
import { networkErrorDetail } from '@shared/network';
import type { ReviewTokenSource } from '@shared/review-providers';

export class GiteaError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
    }
}

export interface GiteaClientOptions {
    /** Resolves when the trusted certificates apply (Settings › Network). No request starts before it. */
    ready: Promise<void>;
    /** The base URL of the server. The client reads it at each request. */
    baseUrl(): string | undefined;
    /** The saved personal access token of the provider, or undefined. */
    savedToken(): Promise<string | undefined>;
    /** The fetch function. Tests replace it. The default is the global fetch of Node, which uses the trusted certificates. */
    fetch?: typeof fetch;
}

/** The number of items on one page. The servers give at most 50 items on a page by default (`MAX_RESPONSE_ITEMS`). */
export const PAGE_SIZE = 50;

/** The largest number of pages that `all` reads. With 50 items on a page, this is 250 items. */
const MAX_PAGES = 5;

/**
 * Sends authenticated requests to the REST API (version 1) of a Gitea or Forgejo server.
 * The token comes from the saved personal access token of the provider, else from GITEA_TOKEN. The client sends it in
 * the "Authorization: token" header, which all versions of Gitea and Forgejo accept.
 * The global fetch of Node uses the trusted certificates of Settings › Network, so a server with a private CA works.
 */
export class GiteaClient {
    private token: Promise<{ value: string; source: ReviewTokenSource }> | undefined;
    private versionPromise: Promise<string> | undefined;

    constructor(private readonly options: GiteaClientOptions) {}

    /** The base URL of the server, for example "https://git.example.com". Undefined when the provider has no server. */
    baseUrl(): string | undefined {
        return normalizeGiteaUrl(this.options.baseUrl());
    }

    /** The host of the server, for example "git.example.com". Undefined when the provider has no server. */
    host(): string | undefined {
        return giteaHostOf(this.baseUrl());
    }

    /** Sends a JSON request to a path of the API, for example "/repos/acme/api". Returns the parsed JSON. */
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const response = await this.send(method, path, body, 'application/json');
        if (response.status === 204) return undefined as T;
        const type = response.headers.get('content-type') ?? '';
        if (type.includes('json')) return (await response.json()) as T;
        const text = await response.text();
        return (text ? text : undefined) as T;
    }

    /** Sends a multipart form, for example an image for an attachment. Returns the parsed JSON of the response. */
    async form<T>(path: string, form: FormData): Promise<T> {
        const response = await this.send('POST', path, form, 'application/json');
        return (await response.json()) as T;
    }

    /** Returns the raw text of a response, for example a diff, a job log, or a file at a commit. */
    async text(path: string): Promise<string> {
        const response = await this.send('GET', path, undefined, '*/*');
        return response.text();
    }

    /**
     * Reads the pages of a list, at most `maxPages` pages. The path gets "limit" and "page".
     * The list ends at a page with fewer items than the limit, or at a page without a "next" link.
     */
    async all<T>(path: string, maxPages = MAX_PAGES): Promise<T[]> {
        const items: T[] = [];
        for (let page = 1; page <= maxPages; page++) {
            const separator = path.includes('?') ? '&' : '?';
            const response = await this.send('GET', `${path}${separator}limit=${PAGE_SIZE}&page=${page}`, undefined, 'application/json');
            const data = (await response.json()) as T[] | null;
            const list = Array.isArray(data) ? data : [];
            items.push(...list);
            const link = response.headers.get('link');
            if (list.length < PAGE_SIZE || (link !== null && !/rel="next"/.test(link))) break;
        }
        return items;
    }

    /** Returns the version text of the server, for example "1.24.3" or "11.0.1+gitea-1.22.0". It reads it one time. */
    version(): Promise<string> {
        if (!this.versionPromise) {
            const next = this.request<{ version?: string }>('GET', '/version').then(data => data?.version ?? '');
            this.versionPromise = next;
            next.catch(() => {
                if (this.versionPromise === next) this.versionPromise = undefined;
            });
        }
        return this.versionPromise;
    }

    /** Returns where the token comes from, or undefined when no token is available. */
    async tokenSource(): Promise<ReviewTokenSource | undefined> {
        return this.getToken().then(
            token => token.source,
            () => undefined
        );
    }

    /** Forgets the token and the version, for example after the user saves a new token or changes the server. */
    reset(): void {
        this.token = undefined;
        this.versionPromise = undefined;
    }

    private async send(method: string, path: string, body: unknown, accept: string): Promise<Response> {
        const base = this.baseUrl();
        if (!base) {
            throw new GiteaError('The Gitea or Forgejo provider has no server URL. Type it in Settings › Code review.', 0);
        }
        const token = await this.getToken();
        let response: Response;
        try {
            response = await (this.options.fetch ?? fetch)(`${base}/api/v1${path}`, {
                method,
                headers: {
                    Authorization: `token ${token.value}`,
                    Accept: accept,
                    'User-Agent': 'ShipWarden',
                    // fetch sets the Content-Type of a form, with the boundary.
                    ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' })
                },
                body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body)
            });
        } catch (error) {
            throw new GiteaError(`ShipWarden cannot connect to ${this.host()}: ${networkErrorDetail(error)}`, 0);
        }
        if (!response.ok) {
            let detail = '';
            try {
                const error = (await response.json()) as { message?: unknown; errors?: unknown };
                detail = typeof error.message === 'string' ? error.message : '';
                if (Array.isArray(error.errors) && error.errors.length > 0) detail = `${detail} ${error.errors.join(' ')}`.trim();
            } catch {
                // The error response has no JSON body.
            }
            if (response.status === 401) {
                this.token = undefined;
                detail = `${detail ? `${detail}. ` : ''}Make sure that the token is correct. Go to Settings › Code review.`;
            } else if (response.status === 403 && !detail) {
                detail =
                    'Make sure that the token has these scopes: repository (read and write), issue (read and write), user (read), and organization (read).';
            }
            throw new GiteaError(`${this.host()} returned ${response.status} for ${method} ${path.replace(/\?.*$/, '')}. ${detail}`.trim(), response.status);
        }
        return response;
    }

    private getToken(): Promise<{ value: string; source: ReviewTokenSource }> {
        const current = this.token;
        if (current) return current;
        const next = (async () => {
            await this.options.ready;
            const saved = await this.options.savedToken();
            if (saved) return { value: saved, source: 'saved' as const };
            if (process.env.GITEA_TOKEN) return { value: process.env.GITEA_TOKEN, source: 'env' as const };
            throw new GiteaError(
                `ShipWarden has no token for ${this.host() ?? 'the Gitea or Forgejo server'}. Add a personal access token in Settings › Code review.`,
                401
            );
        })();
        this.token = next;
        next.catch(() => {
            if (this.token === next) this.token = undefined;
        });
        return next;
    }
}
