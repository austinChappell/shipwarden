import { execFile } from 'child_process';
import { networkErrorDetail } from '@shared/network';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseClaudeUsage, parseCodexUsage, type ProviderUsage, type UsageProvider } from '@shared/usage';

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The time between requests. The requests use no model tokens. Claude's endpoint answers 429
 * when an app asks too often, so Claude gets a longer interval.
 */
export const REFRESH_MS: Record<UsageProvider, number> = { claude: 5 * 60_000, codex: 2 * 60_000 };
/** The time before ShipWarden looks again for a sign-in that was missing. */
const SIGNED_OUT_RETRY_MS = 10 * 60_000;
/** The wait after a 429 answer without a Retry-After header. */
const RATE_LIMIT_WAIT_MS = 15 * 60_000;
/** The refresh button cannot send requests more often than this. */
const MIN_FORCED_INTERVAL_MS = 30_000;

/** A failed request. The message goes to the UI, so it never contains a token. */
class UsageError extends Error {
    constructor(message: string, readonly waitMs?: number) {
        super(message);
    }
}

function run(command: string, args: string[]): Promise<string | undefined> {
    return new Promise(resolve => {
        execFile(command, args, { timeout: 5000 }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
    });
}

async function readFile(file: string): Promise<string | undefined> {
    try {
        return await fs.readFile(file, 'utf8');
    } catch {
        return undefined;
    }
}

/**
 * Returns the OAuth access token of Claude Code, or undefined when Claude Code has no sign-in.
 * Claude Code keeps it in the login keychain on macOS, and in ~/.claude/.credentials.json on other systems.
 */
async function claudeToken(): Promise<string | undefined> {
    const sources = [
        process.platform === 'darwin' ? await run('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']) : undefined,
        await readFile(path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), '.credentials.json'))
    ];
    for (const text of sources) {
        if (!text) {
            continue;
        }
        try {
            const oauth = (JSON.parse(text) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }).claudeAiOauth;
            if (typeof oauth?.accessToken === 'string' && oauth.accessToken) {
                if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < Date.now()) {
                    throw new UsageError('The Claude sign-in expired. Start Claude Code one time to renew it.');
                }
                return oauth.accessToken;
            }
        } catch (error) {
            if (error instanceof UsageError) {
                throw error;
            }
            // The stored value is not valid JSON. Try the next source.
        }
    }
    return undefined;
}

/** Returns the ChatGPT token and account of Codex, or undefined when Codex has no ChatGPT sign-in. */
async function codexAuth(): Promise<{ token: string; accountId?: string } | undefined> {
    const text = await readFile(path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'auth.json'));
    if (!text) {
        return undefined;
    }
    try {
        const tokens = (JSON.parse(text) as { tokens?: { access_token?: unknown; account_id?: unknown } }).tokens;
        return typeof tokens?.access_token === 'string' && tokens.access_token
            ? { token: tokens.access_token, accountId: typeof tokens.account_id === 'string' ? tokens.account_id : undefined }
            : undefined;
    } catch {
        return undefined;
    }
}

async function getJson(url: string, headers: Record<string, string>, signInHint: string): Promise<unknown> {
    let response: Response;
    try {
        response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
        throw new UsageError(`The usage request failed: ${networkErrorDetail(error)}`);
    }
    if (response.status === 401 || response.status === 403) {
        throw new UsageError(signInHint);
    }
    if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RATE_LIMIT_WAIT_MS;
        throw new UsageError(`Too many usage requests. ShipWarden tries again in ${Math.ceil(waitMs / 60_000)} min.`, waitMs);
    }
    if (!response.ok) {
        throw new UsageError(`The usage request failed with HTTP ${response.status}.`);
    }
    return response.json();
}

/**
 * Reads the plan usage of Claude Code and Codex: the same meters that `/usage` shows in the agents.
 * It uses the sign-ins of the agents on this Mac. The tokens stay in memory for one request, and ShipWarden
 * sends them only to the service that issued them.
 */
export class UsageService {
    private readonly state: Record<UsageProvider, ProviderUsage> = {
        claude: { provider: 'claude', status: 'signed-out', windows: [] },
        codex: { provider: 'codex', status: 'signed-out', windows: [] }
    };
    private readonly nextAt: Record<UsageProvider, number> = { claude: 0, codex: 0 };
    private readonly lastRequestAt: Record<UsageProvider, number> = { claude: 0, codex: 0 };
    /** After a 429 answer, no request goes out before this time, also not from the refresh button. */
    private readonly blockedUntil: Record<UsageProvider, number> = { claude: 0, codex: 0 };
    private readonly running = new Set<UsageProvider>();
    private timer: ReturnType<typeof setInterval> | undefined;

    constructor(private readonly userAgent: string, private readonly onChange: (usage: ProviderUsage[]) => void) {}

    start(): void {
        this.refresh();
        // Check every 30 seconds which provider is due. Each provider has its own interval.
        this.timer = setInterval(() => this.refresh(), 30_000);
    }

    stop(): void {
        clearInterval(this.timer);
    }

    get(): ProviderUsage[] {
        return Object.values(this.state);
    }

    /** Updates the providers that are due. `force` also updates the others, but not during a wait after a 429 answer. */
    async refresh(force = false): Promise<ProviderUsage[]> {
        const now = Date.now();
        const due = (Object.keys(this.state) as UsageProvider[]).filter(provider => {
            if (this.running.has(provider)) {
                return false;
            }
            if (now < this.blockedUntil[provider]) {
                return false;
            }
            if (force) {
                return now - this.lastRequestAt[provider] >= MIN_FORCED_INTERVAL_MS;
            }
            return now >= this.nextAt[provider];
        });
        await Promise.all(due.map(provider => this.update(provider)));
        return this.get();
    }

    private async update(provider: UsageProvider): Promise<void> {
        this.running.add(provider);
        const previous = this.state[provider];
        try {
            const result = provider === 'claude' ? await this.fetchClaude() : await this.fetchCodex();
            if (!result) {
                this.state[provider] = { provider, status: 'signed-out', windows: [] };
                this.nextAt[provider] = Date.now() + SIGNED_OUT_RETRY_MS;
            } else {
                this.state[provider] = { provider, status: 'ok', windows: result.windows, plan: result.plan, updatedAt: Date.now() };
                this.nextAt[provider] = Date.now() + REFRESH_MS[provider];
            }
        } catch (error) {
            const usageError = error instanceof UsageError ? error : new UsageError('The usage response was not valid.');
            // Keep the last good values, so a short failure does not empty the status bar.
            this.state[provider] = { ...previous, provider, status: 'error', error: usageError.message };
            this.nextAt[provider] = Date.now() + (usageError.waitMs ?? REFRESH_MS[provider]);
            if (usageError.waitMs) {
                this.blockedUntil[provider] = this.nextAt[provider];
            }
        } finally {
            this.running.delete(provider);
            this.onChange(this.get());
        }
    }

    private async fetchClaude(): Promise<{ windows: ProviderUsage['windows']; plan?: string } | undefined> {
        const token = await claudeToken();
        if (!token) {
            return undefined;
        }
        this.lastRequestAt.claude = Date.now();
        const body = await getJson(CLAUDE_USAGE_URL, {
            Authorization: `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': this.userAgent
        }, 'Claude did not accept the sign-in. Start Claude Code one time to renew it.');
        return { windows: parseClaudeUsage(body) };
    }

    private async fetchCodex(): Promise<{ windows: ProviderUsage['windows']; plan?: string } | undefined> {
        const auth = await codexAuth();
        if (!auth) {
            return undefined;
        }
        this.lastRequestAt.codex = Date.now();
        const body = await getJson(CODEX_USAGE_URL, {
            Authorization: `Bearer ${auth.token}`,
            ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}),
            'User-Agent': this.userAgent
        }, 'ChatGPT did not accept the Codex sign-in. Start Codex one time to renew it.');
        return parseCodexUsage(body);
    }
}
