import { BITBUCKET_API_URL } from '@shared/bitbucket';
import { networkErrorDetail } from '@shared/network';
import type { ReviewTokenSource } from '@shared/review-providers';

export class BitbucketError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
    }
}

export interface BitbucketClientOptions {
    /** Resolves when the trusted certificates apply (Settings › Network). No request starts before it. */
    ready: Promise<void>;
    /** The saved token of the provider, or undefined. */
    savedToken(): Promise<string | undefined>;
    /**
     * The Atlassian account email or the Bitbucket username for Basic auth. The client reads it at each new token.
     * Undefined means that the token is an access token, and the client sends it as a Bearer token.
     */
    username(): string | undefined;
    /** The fetch function. Tests replace it. The default is the global fetch of Node, which uses the trusted certificates. */
    fetch?: typeof fetch;
}

/** The largest number of pages that `all` reads. With 50 items on a page, this is 500 items. */
const MAX_PAGES = 10;

/** One page of a list of the Bitbucket API. `next` is the full URL of the next page. */
interface Page<T> {
    values?: T[];
    next?: string;
}

interface Credentials {
    header: string;
    source: ReviewTokenSource;
}

/**
 * Sends authenticated requests to the Bitbucket Cloud REST API (version 2.0).
 * The token comes from the saved token of the provider, else from BITBUCKET_TOKEN.
 * With a username (an Atlassian API token or an app password), the client sends Basic auth with the username and the
 * token. Without a username (a workspace, project, or repository access token), it sends a Bearer token.
 * The global fetch of Node uses the trusted certificates of Settings › Network.
 */
export class BitbucketClient {
    private credentials: Promise<Credentials> | undefined;

    constructor(private readonly options: BitbucketClientOptions) {}

    /** Sends a JSON request to a path of the API, for example "/repositories/acme/api". Returns the parsed JSON. */
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const response = await this.send(method, path, body, 'application/json');
        if (response.status === 204) return undefined as T;
        const type = response.headers.get('content-type') ?? '';
        if (type.includes('json')) return (await response.json()) as T;
        const text = await response.text();
        return (text ? text : undefined) as T;
    }

    /** Returns the raw text of a response, for example a diff or a step log. The client follows redirects. */
    async text(path: string): Promise<string> {
        const response = await this.send('GET', path, undefined, '*/*');
        return response.text();
    }

    /**
     * Reads all pages of a list, at most `maxPages` pages. The path gets "pagelen=50" when it has no "pagelen".
     * Each page gives the full URL of the next page in `next`. The last page has no `next`.
     */
    async all<T>(path: string, maxPages = MAX_PAGES): Promise<T[]> {
        const items: T[] = [];
        let url: string | undefined = path.includes('pagelen=') ? path : `${path}${path.includes('?') ? '&' : '?'}pagelen=50`;
        for (let count = 0; count < maxPages && url; count++) {
            const page: Page<T> = await this.request<Page<T>>('GET', url);
            items.push(...(page?.values ?? []));
            url = page?.next;
        }
        return items;
    }

    /** Returns where the token comes from, or undefined when no token is available. */
    async tokenSource(): Promise<ReviewTokenSource | undefined> {
        return this.getCredentials().then(
            credentials => credentials.source,
            () => undefined
        );
    }

    /** Forgets the token, for example after the user saves a new token or changes the username. */
    reset(): void {
        this.credentials = undefined;
    }

    /**
     * Returns the full URL of a path. A full URL of the API (the `next` link of a page) stays as it is.
     * A full URL of another server is refused, so the token never goes to another server.
     */
    private urlOf(path: string): string {
        if (!/^https?:\/\//i.test(path)) return `${BITBUCKET_API_URL}${path}`;
        if (!path.startsWith(`${BITBUCKET_API_URL}/`)) {
            throw new BitbucketError(`ShipWarden does not send the Bitbucket token to ${new URL(path).host}.`, 0);
        }
        return path;
    }

    private async send(method: string, path: string, body: unknown, accept: string): Promise<Response> {
        const credentials = await this.getCredentials();
        const url = this.urlOf(path);
        const shortPath = url.slice(BITBUCKET_API_URL.length).replace(/\?.*$/, '');
        let response: Response;
        try {
            response = await (this.options.fetch ?? fetch)(url, {
                method,
                headers: {
                    Authorization: credentials.header,
                    Accept: accept,
                    'User-Agent': 'ShipWarden',
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
                },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
        } catch (error) {
            throw new BitbucketError(`ShipWarden cannot connect to Bitbucket: ${networkErrorDetail(error)}`, 0);
        }
        if (!response.ok) {
            let detail = '';
            try {
                const data = (await response.json()) as { error?: { message?: unknown; detail?: unknown } };
                const message = data.error?.message;
                const more = data.error?.detail;
                detail = [message, more]
                    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
                    .map(part => part.trim().replace(/\.$/, ''))
                    .join('. ');
                if (detail) detail += '.';
            } catch {
                // The error response has no JSON body.
            }
            if (response.status === 401 || response.status === 403) {
                if (response.status === 401) this.credentials = undefined;
                if (!detail || response.status === 401) {
                    detail = `${detail ? `${detail} ` : ''}Make sure that the token and the username are correct, and that the token has the needed scopes. Go to Settings › Code review.`;
                }
            }
            throw new BitbucketError(`Bitbucket returned ${response.status} for ${method} ${shortPath}. ${detail}`.trim(), response.status);
        }
        return response;
    }

    private getCredentials(): Promise<Credentials> {
        const current = this.credentials;
        if (current) return current;
        const next = (async (): Promise<Credentials> => {
            await this.options.ready;
            const saved = await this.options.savedToken();
            const token = saved || process.env.BITBUCKET_TOKEN;
            if (!token) {
                throw new BitbucketError(
                    'ShipWarden has no Bitbucket token. Add an API token or an access token in Settings › Code review, or set BITBUCKET_TOKEN.',
                    401
                );
            }
            const source: ReviewTokenSource = saved ? 'saved' : 'env';
            const username = (saved ? this.options.username() : (this.options.username() ?? process.env.BITBUCKET_USERNAME))?.trim();
            const header = username ? `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}` : `Bearer ${token}`;
            return { header, source };
        })();
        this.credentials = next;
        next.catch(() => {
            if (this.credentials === next) this.credentials = undefined;
        });
        return next;
    }
}
