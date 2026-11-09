import { execFile } from 'child_process';
import { networkErrorDetail } from '@shared/network';
import type { ReviewTokenSource } from '@shared/review-providers';

const API = 'https://api.github.com';

export class GitHubError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
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
            return pick ? pick(page) : page as T[];
        };
        const first = `${API}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
        const response = await this.fetch('GET', first);
        const items = await take(response);
        const links = response.headers.get('link') ?? '';
        const last = /<([^>]+)>;\s*rel="last"/.exec(links)?.[1];
        const lastPage = last ? Number(new URL(last).searchParams.get('page')) : NaN;
        if (Number.isInteger(lastPage) && lastPage > 1) {
            const count = Math.min(lastPage, Math.ceil(limit / 100));
            const pages = await Promise.all(Array.from({ length: count - 1 }, (_, index) => {
                const url = new URL(first);
                url.searchParams.set('page', String(index + 2));
                return this.fetch('GET', url.toString()).then(take);
            }));
            return items.concat(...pages).slice(0, limit);
        }
        let url = /<([^>]+)>;\s*rel="next"/.exec(links)?.[1];
        while (url && items.length < limit) {
            const next = await this.fetch('GET', url);
            items.push(...await take(next));
            url = /<([^>]+)>;\s*rel="next"/.exec(next.headers.get('link') ?? '')?.[1];
        }
        return items.slice(0, limit);
    }

    /**
     * Sends a GraphQL query. A query that GitHub stops because of its time limit gives 502, 503, 504 or an incomplete body.
     * The query is a read or an idempotent change, so the client tries it again 2 times.
     */
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        let result: { data?: T; errors?: { message: string }[] };
        for (let attempt = 0; ; attempt++) {
            try {
                const response = await this.fetch('POST', `${API}/graphql`, { query, variables });
                result = await response.json() as typeof result;
                break;
            } catch (error) {
                // A response that GitHub stops early has no complete JSON body. It is the same failure as a 502.
                const retry = error instanceof GitHubError ? [502, 503, 504].includes(error.status) : error instanceof SyntaxError;
                if (attempt >= 2 || !retry) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }
        if (result.errors?.length) {
            throw new GitHubError(`GitHub returned an error: ${result.errors.map(error => error.message).join(' ')}`, 200);
        }
        return result.data as T;
    }

    private async fetch(method: string, url: string, body?: unknown, accept = 'application/vnd.github+json'): Promise<Response> {
        const token = (await this.getToken()).value;
        let response: Response;
        try {
            response = await fetch(url, {
                method,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': accept,
                    'X-GitHub-Api-Version': '2022-11-28',
                    'User-Agent': 'ShipWarden',
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
                },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
        } catch (error) {
            throw new GitHubError(`ShipWarden cannot connect to GitHub: ${networkErrorDetail(error)}`, 0);
        }
        if (!response.ok) {
            let detail = '';
            try {
                const error = await response.json() as { message?: string; errors?: { message?: string }[] };
                detail = [error.message, ...(error.errors ?? []).map(item => item.message)].filter(Boolean).join(' ');
            } catch {
                // The error response has no JSON body.
            }
            if (response.status === 401) {
                this.token = undefined;
            }
            throw new GitHubError(`GitHub returned ${response.status} for ${method} ${url.replace(API, '')}. ${detail}`.trim(), response.status);
        }
        return response;
    }

    /** Returns the GitHub token, or undefined when there is none. Public repositories work without it. */
    async optionalToken(): Promise<string | undefined> {
        return this.getToken().then(token => token.value, () => undefined);
    }

    /** Returns where the token comes from, or undefined when no token is available. */
    async tokenSource(): Promise<ReviewTokenSource | undefined> {
        return this.getToken().then(token => token.source, () => undefined);
    }

    /** Forgets the token, for example after the user saves a new token. */
    reset(): void {
        this.token = undefined;
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
                        reject(new Error(account
                            ? `ShipWarden cannot get a GitHub token for the account "${account}". Run "gh auth login" for this account, or save a token in Settings › Code review.`
                            : 'ShipWarden cannot get a GitHub token. Install the GitHub CLI and run "gh auth login", set GITHUB_TOKEN, or save a token in Settings › Code review.'));
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
