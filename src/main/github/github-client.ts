import { execFile } from 'child_process';
import { networkErrorDetail } from '@shared/network';

const API = 'https://api.github.com';

export class GitHubError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

/**
 * Sends authenticated requests to the GitHub REST and GraphQL APIs.
 * The token comes from the GitHub CLI (`gh auth token`). The GITHUB_TOKEN environment variable has priority.
 */
export class GitHubClient {
    private token: Promise<string> | undefined;

    constructor(private readonly ready: Promise<void>) {}

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
        const token = await this.getToken();
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
        return this.getToken().catch(() => undefined);
    }

    private getToken(): Promise<string> {
        this.token ??= (async () => {
            if (process.env.GITHUB_TOKEN) {
                return process.env.GITHUB_TOKEN;
            }
            await this.ready;
            return new Promise<string>((resolve, reject) => {
                execFile('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 10000 }, (error, stdout) => {
                    const token = stdout?.trim();
                    if (error || !token) {
                        reject(new Error('ShipWarden cannot get a GitHub token. Install the GitHub CLI and run "gh auth login", or set GITHUB_TOKEN.'));
                    } else {
                        resolve(token);
                    }
                });
            });
        })();
        this.token.catch(() => {
            this.token = undefined;
        });
        return this.token;
    }
}
