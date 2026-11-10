import { execFile } from 'child_process';
import { networkErrorDetail } from '@shared/network';
import { AZURE_API_VERSION, AZURE_DEVOPS_RESOURCE } from '@shared/azure-devops';

export class AzureError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
    }
}

/** Where the token of a request comes from. */
export type AzureTokenSource = 'env' | 'saved' | 'az';

interface AzureAuth {
    header: string;
    source: AzureTokenSource;
    /** The time when the token stops. Only an `az` token has a limit. */
    expires?: number;
}

/** The az CLI token is valid for about 60 minutes. The client gets a new one after this time. */
const AZ_TOKEN_MS = 45 * 60 * 1000;

/** Gets an access token for Azure DevOps from the az CLI. */
export function azCliToken(): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            'az',
            ['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE, '--query', 'accessToken', '-o', 'tsv'],
            { timeout: 20000 },
            (error, stdout) => {
                const token = stdout?.trim();
                if (error || !token) {
                    reject(new Error('The az CLI did not give a token.'));
                } else {
                    resolve(token);
                }
            }
        );
    });
}

/**
 * Adds the API version to a URL when it has none. The connection data endpoint is not versioned like the others,
 * so it gets no version.
 */
export function withApiVersion(url: string): string {
    if (/[?&]api-version=/.test(url) || /\/_apis\/connectionData(?:$|\?)/.test(url)) return url;
    return `${url}${url.includes('?') ? '&' : '?'}api-version=${AZURE_API_VERSION}`;
}

export interface AzureClientOptions {
    /** Resolves when the trusted certificates apply (Settings › Network). No request starts before it. */
    ready: Promise<void>;
    /** The saved personal access token, or undefined. */
    savedToken(): Promise<string | undefined>;
    /** Gets a token from the az CLI. Tests replace it. */
    azToken?: () => Promise<string>;
}

/**
 * Sends authenticated requests to the Azure DevOps REST API (version 7.1).
 * The token comes from the saved personal access token of the provider, else from AZURE_DEVOPS_EXT_PAT, else from the az CLI.
 * The client uses the global fetch of Node, so the trusted certificates of Settings › Network apply.
 */
export class AzureDevOpsClient {
    private auth: Promise<AzureAuth> | undefined;

    constructor(private readonly options: AzureClientOptions) {}

    /** Sends a JSON request. Returns the parsed JSON, or the text when the response is not JSON. */
    async request<T>(method: string, url: string, body?: unknown, contentType = 'application/json'): Promise<T> {
        const response = await this.fetch(method, url, body, 'application/json', contentType);
        if (response.status === 204) {
            return undefined as T;
        }
        const type = response.headers.get('content-type') ?? '';
        return (type.includes('json') ? await response.json() : await response.text()) as T;
    }

    /** Returns the raw text of a response, for example a log or a file at a commit. */
    async text(url: string, accept = 'text/plain'): Promise<string> {
        const response = await this.fetch('GET', url, undefined, accept);
        return response.text();
    }

    /** Returns where the token comes from, or undefined when no token is available. */
    async tokenSource(): Promise<AzureTokenSource | undefined> {
        try {
            return (await this.getAuth()).source;
        } catch {
            return undefined;
        }
    }

    /** Forgets the token, for example after the user saves a new token. */
    reset(): void {
        this.auth = undefined;
    }

    private async fetch(method: string, rawUrl: string, body: unknown, accept: string, contentType = 'application/json'): Promise<Response> {
        const auth = await this.getAuth();
        const url = withApiVersion(rawUrl);
        let response: Response;
        try {
            response = await fetch(url, {
                method,
                headers: {
                    Authorization: auth.header,
                    Accept: accept,
                    'User-Agent': 'ShipWarden',
                    // Without this header, Azure DevOps can answer 203 with a sign-in page in place of 401.
                    'X-TFS-FedAuthRedirect': 'Suppress',
                    ...(body === undefined ? {} : { 'Content-Type': contentType })
                },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
        } catch (error) {
            throw new AzureError(`ShipWarden cannot connect to Azure DevOps: ${networkErrorDetail(error)}`, 0);
        }
        const signIn = response.status === 203 && !(response.headers.get('content-type') ?? '').includes('json');
        if (!response.ok || signIn) {
            const status = signIn ? 401 : response.status;
            let detail = '';
            try {
                const error = (await response.json()) as { message?: string };
                detail = error.message ?? '';
            } catch {
                // The error response has no JSON body.
            }
            if (status === 401 || status === 403) {
                this.auth = undefined;
                if (!detail) {
                    detail = 'Make sure that the token is correct and has the necessary scopes (Code, Build). Go to Settings › Code review.';
                }
            }
            const path = url.replace(/^https:\/\/dev\.azure\.com/, '').replace(/[?&]api-version=[^&]*/, '');
            throw new AzureError(`Azure DevOps returned ${status} for ${method} ${path}. ${detail}`.trim(), status);
        }
        return response;
    }

    private getAuth(): Promise<AzureAuth> {
        const current = this.auth;
        if (current) {
            return current.then(auth => {
                if (auth.expires && auth.expires < Date.now()) {
                    this.auth = undefined;
                    return this.getAuth();
                }
                return auth;
            });
        }
        const next = (async (): Promise<AzureAuth> => {
            await this.options.ready;
            const basic = (token: string) => `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
            const saved = await this.options.savedToken();
            if (saved) {
                return { header: basic(saved), source: 'saved' };
            }
            if (process.env.AZURE_DEVOPS_EXT_PAT) {
                return { header: basic(process.env.AZURE_DEVOPS_EXT_PAT), source: 'env' };
            }
            try {
                const token = await (this.options.azToken ?? azCliToken)();
                return { header: `Bearer ${token}`, source: 'az', expires: Date.now() + AZ_TOKEN_MS };
            } catch {
                throw new AzureError('ShipWarden has no Azure DevOps token. Add a personal access token in Settings › Code review, or run "az login".', 401);
            }
        })();
        this.auth = next;
        next.catch(() => {
            if (this.auth === next) this.auth = undefined;
        });
        return next;
    }
}
