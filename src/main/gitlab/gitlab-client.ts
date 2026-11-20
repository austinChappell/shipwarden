import { execFile } from 'child_process';
import { networkErrorDetail } from '@shared/network';
import type { ReviewTokenSource } from '@shared/review-providers';
import { GITLAB_DEFAULT_URL, gitlabHostOf, normalizeGitLabUrl } from '@shared/gitlab';

export class GitLabError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
    }
}

/** Runs the glab CLI and returns its output. It rejects when the command fails or gives no output. */
function runGlab(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('glab', args, { timeout: 10000 }, (error, stdout) => {
            const text = stdout?.trim();
            if (error || !text) reject(error ?? new Error('No output.'));
            else resolve(text);
        });
    });
}

/**
 * Gets the token of the glab CLI for a host. The token comes from the glab config ("glab config get token").
 * A newer glab that keeps the token in the keychain gives it with "glab auth token".
 */
export async function glabToken(host: string): Promise<string> {
    try {
        return await runGlab(['config', 'get', 'token', '--host', host]);
    } catch {
        try {
            return await runGlab(['auth', 'token', '--hostname', host]);
        } catch {
            throw new Error('The glab CLI did not give a token.');
        }
    }
}

export interface GitLabClientOptions {
    /** Resolves when the trusted certificates apply (Settings › Network). No request starts before it. */
    ready: Promise<void>;
    /** The base URL of the server. Undefined means https://gitlab.com. The client reads it at each request. */
    baseUrl(): string | undefined;
    /** The saved personal access token of the provider, or undefined. */
    savedToken(): Promise<string | undefined>;
    /** Gets the token of the glab CLI for a host. Tests replace it. */
    cliToken?: (host: string) => Promise<string>;
    /** The fetch function. Tests replace it. The default is the global fetch of Node, which uses the trusted certificates. */
    fetch?: typeof fetch;
}

/** The largest number of pages that `all` reads. With 100 items on a page, this is 1000 items. */
const MAX_PAGES = 10;

/**
 * Sends authenticated requests to the GitLab REST API (version 4).
 * The token comes from the saved personal access token of the provider, else from GITLAB_TOKEN (only for gitlab.com),
 * else from the glab CLI. The client sends the token as a Bearer token, so a personal access token and an OAuth token of
 * glab both work. The global fetch of Node uses the trusted certificates of Settings › Network.
 */
export class GitLabClient {
    private token: Promise<{ value: string; source: ReviewTokenSource }> | undefined;

    constructor(private readonly options: GitLabClientOptions) {}

    /** The base URL of the server, for example "https://gitlab.com". */
    baseUrl(): string {
        return normalizeGitLabUrl(this.options.baseUrl()) ?? GITLAB_DEFAULT_URL;
    }

    /** The host of the server, for example "gitlab.com". */
    host(): string {
        return gitlabHostOf(this.baseUrl()) ?? 'gitlab.com';
    }

    /** Sends a JSON request to a path of the API, for example "/projects/acme%2Fweb". Returns the parsed JSON. */
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const response = await this.send(method, path, body, 'application/json');
        if (response.status === 204) return undefined as T;
        const type = response.headers.get('content-type') ?? '';
        return (type.includes('json') ? await response.json() : await response.text()) as T;
    }

    /** Returns the raw text of a response, for example a job log or a file at a commit. */
    async text(path: string): Promise<string> {
        const response = await this.send('GET', path, undefined, '*/*');
        return response.text();
    }

    /**
     * Reads all pages of a list, at most `maxPages` pages. The path gets "per_page=100".
     * The "x-next-page" header gives the next page. GitLab leaves it empty on the last page.
     */
    async all<T>(path: string, maxPages = MAX_PAGES): Promise<T[]> {
        const items: T[] = [];
        let page = 1;
        for (let count = 0; count < maxPages; count++) {
            const separator = path.includes('?') ? '&' : '?';
            const response = await this.send('GET', `${path}${separator}per_page=100&page=${page}`, undefined, 'application/json');
            const data = (await response.json()) as T[];
            items.push(...data);
            const next = Number(response.headers.get('x-next-page'));
            if (!next || data.length === 0) break;
            page = next;
        }
        return items;
    }

    /** Returns where the token comes from, or undefined when no token is available. */
    async tokenSource(): Promise<ReviewTokenSource | undefined> {
        return this.getToken().then(
            token => token.source,
            () => undefined
        );
    }

    /** Forgets the token, for example after the user saves a new token or changes the server. */
    reset(): void {
        this.token = undefined;
    }

    private async send(method: string, path: string, body: unknown, accept: string): Promise<Response> {
        const token = await this.getToken();
        const url = `${this.baseUrl()}/api/v4${path}`;
        let response: Response;
        try {
            response = await (this.options.fetch ?? fetch)(url, {
                method,
                headers: {
                    Authorization: `Bearer ${token.value}`,
                    Accept: accept,
                    'User-Agent': 'ShipWarden',
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
                },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
        } catch (error) {
            throw new GitLabError(`ShipWarden cannot connect to GitLab (${this.host()}): ${networkErrorDetail(error)}`, 0);
        }
        if (!response.ok) {
            let detail = '';
            try {
                const error = (await response.json()) as { message?: unknown; error?: unknown; error_description?: unknown };
                const message = error.message ?? error.error_description ?? error.error;
                detail = typeof message === 'string' ? message : message ? JSON.stringify(message) : '';
            } catch {
                // The error response has no JSON body.
            }
            if (response.status === 401 || response.status === 403) {
                if (response.status === 401) this.token = undefined;
                if (!detail || response.status === 401) {
                    detail = `${detail ? `${detail}. ` : ''}Make sure that the token is correct and has the "api" scope. Go to Settings › Code review.`;
                }
            }
            throw new GitLabError(`GitLab returned ${response.status} for ${method} ${path.replace(/\?.*$/, '')}. ${detail}`.trim(), response.status);
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
            const host = this.host();
            if (host === 'gitlab.com' && process.env.GITLAB_TOKEN) return { value: process.env.GITLAB_TOKEN, source: 'env' as const };
            try {
                return { value: await (this.options.cliToken ?? glabToken)(host), source: 'cli' as const };
            } catch {
                throw new GitLabError(
                    `ShipWarden has no GitLab token for ${host}. Add a personal access token in Settings › Code review, or run "glab auth login --hostname ${host}".`,
                    401
                );
            }
        })();
        this.token = next;
        next.catch(() => {
            if (this.token === next) this.token = undefined;
        });
        return next;
    }
}
