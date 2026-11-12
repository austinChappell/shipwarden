import { execFile } from 'child_process';
import { networkErrorDetail } from '@shared/network';
import type { ReviewTokenSource } from '@shared/review-providers';

const API = 'https://api.github.com';

/** The statuses that GitHub gives when a request fails for a short time. */
const RETRY_STATUSES = [502, 503, 504];

/** The number of requests that run at the same time. Other requests wait. Bursts trigger the secondary rate limit of GitHub. */
const MAX_REQUESTS = 6;

/** The number of GraphQL requests that run at the same time. GitHub counts the server time of GraphQL queries for the secondary rate limit. */
const MAX_GRAPHQL_REQUESTS = 2;

/** The first pause after a secondary rate limit without a time. GitHub tells clients to wait at least one minute. */
const FIRST_PAUSE_MS = 60_000;

/** The longest pause after a secondary rate limit. Each limit in a row doubles the pause, up to this value. */
const MAX_PAUSE_MS = 15 * 60_000;

/** The number of GET responses that the client keeps for conditional requests. */
const MAX_CACHED_RESPONSES = 500;

/** The largest response body (characters) that the client keeps. Larger bodies, for example job logs, are not kept. */
const MAX_CACHED_BODY = 1_000_000;

/** The total size (characters) of all kept response bodies. */
const MAX_CACHED_TOTAL = 30_000_000;

/** The response headers that a kept response gives again. The client reads only these headers. */
const KEPT_HEADERS = ['content-type', 'link'];

/** A kept GET response. The client sends its ETag in If-None-Match. A 304 response gives this body again. */
interface CachedResponse {
    etag: string;
    body: string;
    headers: [string, string][];
}

export class GitHubError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
    }
}

/** GitHub stopped the requests because of a rate limit. The client sends no requests before `retryAt`. */
export class GitHubRateLimitError extends GitHubError {
    constructor(readonly retryAt: number) {
        const time = new Date(retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        super(`GitHub stopped the requests from ShipWarden because of its rate limit. ShipWarden sends requests again at ${time}.`, 429);
    }
}

/** Runs at most `size` tasks at the same time. The other tasks wait in order. */
class Slots {
    private active = 0;

    private readonly waiting: (() => void)[] = [];

    constructor(private readonly size: number) {}

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active < this.size) {
            this.active++;
        } else {
            // The task that ends gives its place to this task. The count does not change.
            await new Promise<void>(resolve => this.waiting.push(resolve));
        }
        try {
            return await task();
        } finally {
            const next = this.waiting.shift();
            if (next) {
                next();
            } else {
                this.active--;
            }
        }
    }
}

export interface GitHubClientOptions {
    /** Resolves when the trusted certificates apply (Settings › Network). No request starts before it. */
    ready: Promise<void>;
    /** The saved personal access token of the provider, or undefined. */
    savedToken?(): Promise<string | undefined>;
    /** The account of the GitHub CLI. Undefined means the active account. */
    cliAccount?(): string | undefined;
}

/**
 * Sends authenticated requests to the GitHub REST and GraphQL APIs.
 * The token comes from the saved personal access token, else from GITHUB_TOKEN, else from the GitHub CLI (`gh auth token`).
 * When the provider has a GitHub CLI account, the client does not use GITHUB_TOKEN.
 */
export class GitHubClient {
    private token: Promise<{ value: string; source: ReviewTokenSource }> | undefined;

    private readonly slots = new Slots(MAX_REQUESTS);

    private readonly graphqlSlots = new Slots(MAX_GRAPHQL_REQUESTS);

    /** The time (ms) before which the client sends no requests, after a rate limit. */
    private pausedUntil = 0;

    /** The last pause after a secondary rate limit without a time. Zero after a successful request. */
    private pauseMs = 0;

    /** The last response of each GET request with an ETag, by Accept header and URL. The Map order is the order of use. */
    private readonly etags = new Map<string, CachedResponse>();

    /** The total size of the kept response bodies. */
    private etagChars = 0;

    constructor(private readonly options: GitHubClientOptions) {}

    async rest<T>(method: string, path: string, body?: unknown, accept = 'application/vnd.github+json'): Promise<T> {
        const response = await this.fetch(method, `${API}${path}`, body, accept);
        if (response.status === 204) {
            return undefined as T;
        }
        const type = response.headers.get('content-type') ?? '';
        return (type.includes('json') ? await response.json() : await response.text()) as T;
    }

    /** Returns the raw text of a response, for example a job log or a file at a commit. */
    async text(path: string, accept = 'application/vnd.github.raw'): Promise<string> {
        const response = await this.fetch('GET', `${API}${path}`, undefined, accept);
        return response.text();
    }

    /**
     * Gets all pages of a list endpoint. `pick` selects the items when the response is an object.
     * When the first response gives the number of the last page, the other pages load at the same time.
     */
    async paginate<T>(path: string, pick?: (page: unknown) => T[], limit = 3000): Promise<T[]> {
        const take = async (response: Response) => {
            const page = await response.json();
            return pick ? pick(page) : (page as T[]);
        };
        const first = `${API}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
        const response = await this.fetch('GET', first);
        const items = await take(response);
        const links = response.headers.get('link') ?? '';
        const last = /<([^>]+)>;\s*rel="last"/.exec(links)?.[1];
        const lastPage = last ? Number(new URL(last).searchParams.get('page')) : NaN;
        if (Number.isInteger(lastPage) && lastPage > 1) {
            const count = Math.min(lastPage, Math.ceil(limit / 100));
            const pages = await Promise.all(
                Array.from({ length: count - 1 }, (_, index) => {
                    const url = new URL(first);
                    url.searchParams.set('page', String(index + 2));
                    return this.fetch('GET', url.toString()).then(take);
                })
            );
            return items.concat(...pages).slice(0, limit);
        }
        let url = /<([^>]+)>;\s*rel="next"/.exec(links)?.[1];
        while (url && items.length < limit) {
            const next = await this.fetch('GET', url);
            items.push(...(await take(next)));
            url = /<([^>]+)>;\s*rel="next"/.exec(next.headers.get('link') ?? '')?.[1];
        }
        return items.slice(0, limit);
    }

    /**
     * Sends a GraphQL query. A query that GitHub stops because of its time limit gives 502, 503, 504 or an incomplete body.
     * The query is a read or an idempotent change, so the client tries it again 2 times.
     */
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        let result: { data?: T; errors?: { message: string; type?: string }[] };
        let response: Response;
        for (let attempt = 0; ; attempt++) {
            try {
                response = await this.fetch('POST', `${API}/graphql`, { query, variables });
                result = (await response.json()) as typeof result;
                break;
            } catch (error) {
                // A response that GitHub stops early has no complete JSON body. It is the same failure as a 502.
                const retry = error instanceof GitHubError ? RETRY_STATUSES.includes(error.status) : error instanceof SyntaxError;
                if (attempt >= 2 || !retry) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }
        // GitHub can give a rate limit of GraphQL as an error in a 200 response.
        if (result.errors?.some(error => error.type === 'RATE_LIMITED')) {
            throw new GitHubRateLimitError(this.pause(response, true)!);
        }
        if (result.errors?.length) {
            throw new GitHubError(`GitHub returned an error: ${result.errors.map(error => error.message).join(' ')}`, 200);
        }
        return result.data as T;
    }

    /**
     * Sends a request. GitHub sometimes gives 502, 503 or 504 for a short time.
     * A GET request does not change data, so the client tries it again 2 times.
     */
    private async fetch(method: string, url: string, body?: unknown, accept = 'application/vnd.github+json'): Promise<Response> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.fetchOnce(method, url, body, accept);
            } catch (error) {
                const retry = method === 'GET' && error instanceof GitHubError && RETRY_STATUSES.includes(error.status);
                if (attempt >= 2 || !retry) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }
    }

    private async fetchOnce(method: string, url: string, body?: unknown, accept = 'application/vnd.github+json'): Promise<Response> {
        const token = (await this.getToken()).value;
        const graphql = url === `${API}/graphql`;
        const cacheKey = method === 'GET' && !graphql ? `${accept} ${url}` : undefined;
        const cached = cacheKey === undefined ? undefined : this.etags.get(cacheKey);
        const send = async () => {
            // A request that waited for a place can find a pause that started during the wait.
            if (Date.now() < this.pausedUntil) {
                throw new GitHubRateLimitError(this.pausedUntil);
            }
            try {
                return await fetch(url, {
                    method,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: accept,
                        'X-GitHub-Api-Version': '2022-11-28',
                        'User-Agent': 'ShipWarden',
                        ...(cached ? { 'If-None-Match': cached.etag } : {}),
                        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
                    },
                    body: body === undefined ? undefined : JSON.stringify(body)
                });
            } catch (error) {
                throw new GitHubError(`ShipWarden cannot connect to GitHub: ${networkErrorDetail(error)}`, 0);
            }
        };
        // A GraphQL request gets its GraphQL place first. Thus a waiting GraphQL request does not block a REST request.
        const response = await (graphql ? this.graphqlSlots.run(() => this.slots.run(send)) : this.slots.run(send));
        if (response.status === 304 && cacheKey !== undefined && cached) {
            // The data did not change. A 304 does not count for the primary rate limit of GitHub.
            this.pauseMs = 0;
            this.etags.delete(cacheKey);
            this.etags.set(cacheKey, cached);
            return new Response(cached.body, { status: 200, headers: cached.headers });
        }
        if (response.ok) {
            this.pauseMs = 0;
            const etag = response.headers.get('etag');
            if (cacheKey !== undefined && etag && response.status === 200) {
                const text = await response.text();
                const headers = KEPT_HEADERS.flatMap(name => {
                    const value = response.headers.get(name);
                    return value === null ? [] : [[name, value] as [string, string]];
                });
                this.forget(cacheKey);
                if (text.length <= MAX_CACHED_BODY) {
                    this.etags.set(cacheKey, { etag, body: text, headers });
                    this.etagChars += text.length;
                    // Remove the entries that the client used the longest time ago.
                    while (this.etags.size > MAX_CACHED_RESPONSES || this.etagChars > MAX_CACHED_TOTAL) {
                        this.forget(this.etags.keys().next().value!);
                    }
                }
                return new Response(text, { status: 200, headers });
            }
        } else {
            let detail = '';
            try {
                const error = (await response.json()) as { message?: string; errors?: { message?: string }[] };
                detail = [error.message, ...(error.errors ?? []).map(item => item.message)].filter(Boolean).join(' ');
            } catch {
                // The error response has no JSON body.
            }
            if (response.status === 401) {
                this.token = undefined;
            }
            if (response.status === 403 || response.status === 429) {
                const retryAt = this.pause(response, /rate limit/i.test(detail));
                if (retryAt !== undefined) {
                    throw new GitHubRateLimitError(retryAt);
                }
            }
            throw new GitHubError(`GitHub returned ${response.status} for ${method} ${url.replace(API, '')}. ${detail}`.trim(), response.status);
        }
        return response;
    }

    /** Removes a kept response. */
    private forget(key: string): void {
        const entry = this.etags.get(key);
        if (entry) {
            this.etagChars -= entry.body.length;
            this.etags.delete(key);
        }
    }

    /**
     * Starts a pause after a rate limit and returns its end (ms). Returns undefined when the response is not a rate limit.
     * The order follows the GitHub documentation: the retry-after header, then the reset time of a used limit,
     * then a pause of one minute or more. `limited` is true when the response text tells of a rate limit.
     */
    private pause(response: Response, limited: boolean): number | undefined {
        const now = Date.now();
        const retryAfter = Number(response.headers.get('retry-after') ?? NaN);
        const reset = Number(response.headers.get('x-ratelimit-reset') ?? NaN);
        let end: number | undefined;
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
            end = now + retryAfter * 1000;
        } else if (response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset)) {
            end = reset * 1000 + 1000;
        } else if (limited) {
            // Many requests can fail at the same time. Only the first failure of a pause makes the next pause longer.
            if (now >= this.pausedUntil) {
                this.pauseMs = this.pauseMs ? Math.min(this.pauseMs * 2, MAX_PAUSE_MS) : FIRST_PAUSE_MS;
            }
            end = now + this.pauseMs;
        }
        if (end !== undefined) {
            this.pausedUntil = Math.max(this.pausedUntil, end);
            return this.pausedUntil;
        }
        return undefined;
    }

    /** Returns the GitHub token, or undefined when there is none. Public repositories work without it. */
    async optionalToken(): Promise<string | undefined> {
        return this.getToken().then(
            token => token.value,
            () => undefined
        );
    }

    /** Returns where the token comes from, or undefined when no token is available. */
    async tokenSource(): Promise<ReviewTokenSource | undefined> {
        return this.getToken().then(
            token => token.source,
            () => undefined
        );
    }

    /** Forgets the token, for example after the user saves a new token. */
    reset(): void {
        this.token = undefined;
        this.etags.clear();
        this.etagChars = 0;
    }

    private getToken(): Promise<{ value: string; source: ReviewTokenSource }> {
        this.token ??= (async () => {
            const saved = await this.options.savedToken?.();
            if (saved) {
                return { value: saved, source: 'saved' as const };
            }
            const account = this.options.cliAccount?.();
            if (!account && process.env.GITHUB_TOKEN) {
                return { value: process.env.GITHUB_TOKEN, source: 'env' as const };
            }
            await this.options.ready;
            const args = ['auth', 'token', '--hostname', 'github.com', ...(account ? ['--user', account] : [])];
            const value = await new Promise<string>((resolve, reject) => {
                execFile('gh', args, { timeout: 10000 }, (error, stdout) => {
                    const token = stdout?.trim();
                    if (error || !token) {
                        reject(
                            new Error(
                                account
                                    ? `ShipWarden cannot get a GitHub token for the account "${account}". Run "gh auth login" for this account, or save a token in Settings › Code review.`
                                    : 'ShipWarden cannot get a GitHub token. Install the GitHub CLI and run "gh auth login", set GITHUB_TOKEN, or save a token in Settings › Code review.'
                            )
                        );
                    } else {
                        resolve(token);
                    }
                });
            });
            return { value, source: 'cli' as const };
        })();
        this.token.catch(() => {
            this.token = undefined;
        });
        return this.token;
    }
}
