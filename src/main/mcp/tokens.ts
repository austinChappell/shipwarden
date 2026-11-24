import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { mcpConfig } from '@shared/mcp';
import { JsonStore } from '../tasks/json-store';

/** A token stays valid for this time at most. An agent session that runs longer must start again. */
export const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface TokenEntry {
    worktree: string;
    createdAt: number;
    /** The terminal session of the agent. The token ends when the session exits. */
    sessionId?: string;
    /** The MCP config file of the session, if the agent gets a file. It has the token, so it goes away with the token. */
    configFile?: string;
}

interface TokenFile {
    /** The port of the last server. The next app run tries it first, so agents that still run can reach the server again. */
    port?: number;
    /** The tokens by their SHA-256 hash. The file does not keep the tokens. */
    tokens: Record<string, TokenEntry>;
}

export interface IssuedToken {
    /** The hash of the token. `bindSession` uses it. */
    id: string;
    token: string;
    /** The URL of the MCP endpoint. */
    url: string;
    /** The private MCP config file of the session, or undefined when the agent gets no file. */
    configFile?: string;
}

/** Returns the content of the MCP config file of a session, or undefined for no file. */
export type McpConfigContent = (url: string, token: string) => unknown;

function hashOf(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

/**
 * The tokens of the MCP server. Each agent session gets its own token, and the token identifies the worktree of the
 * session. The tools then act on "this worktree". The file keeps only the hashes, so the tokens stay valid after an app
 * restart while the agents continue to run in the PTY host.
 */
export class McpTokens {
    private readonly store: JsonStore<TokenFile>;

    constructor(
        file: string,
        private readonly configFolder: string,
        private readonly now: () => number = Date.now
    ) {
        this.store = new JsonStore<TokenFile>(file, () => ({ tokens: {} }));
    }

    /**
     * Makes a token for a worktree and writes the MCP config file of the session. Only the user can read the file.
     * `content` gives the content of the file. The default is the config of Claude Code. When `content` gives undefined,
     * the session gets no file.
     */
    async issue(worktree: string, url: string, content: McpConfigContent = mcpConfig): Promise<IssuedToken> {
        const token = randomBytes(32).toString('base64url');
        const id = hashOf(token);
        const config = content(url, token);
        let configFile: string | undefined;
        if (config !== undefined) {
            await fs.mkdir(this.configFolder, { recursive: true, mode: 0o700 });
            configFile = join(this.configFolder, `${id.slice(0, 32)}.json`);
            await fs.writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
        }
        const entry: TokenEntry = { worktree, createdAt: this.now(), ...(configFile ? { configFile } : {}) };
        await this.store.update(file => ({ ...file, tokens: { ...this.tokens(file), [id]: entry } }));
        return { id, token, url, configFile };
    }

    /** Returns the worktree of a token, or undefined for an unknown or old token. */
    async worktreeOf(token: string): Promise<string | undefined> {
        return (await this.identify(token))?.worktree;
    }

    /** Returns the worktree and the terminal session of a token, or undefined for an unknown or old token. */
    async identify(token: string): Promise<{ worktree: string; sessionId?: string } | undefined> {
        if (!token) return undefined;
        const entry = this.tokens(await this.store.get())[hashOf(token)];
        if (!entry || this.now() - entry.createdAt > TOKEN_MAX_AGE_MS) return undefined;
        return { worktree: entry.worktree, ...(entry.sessionId ? { sessionId: entry.sessionId } : {}) };
    }

    /** Connects a token to the terminal session of its agent. */
    async bindSession(id: string, sessionId: string): Promise<void> {
        await this.store.update(file => {
            const tokens = this.tokens(file);
            if (!tokens[id]) return undefined;
            return { ...file, tokens: { ...tokens, [id]: { ...tokens[id], sessionId } } };
        });
    }

    /** Ends the tokens of a terminal session, for example when the agent exits. */
    async revokeSession(sessionId: string): Promise<void> {
        await this.remove(entry => entry.sessionId === sessionId);
    }

    /**
     * Ends the tokens that are older than the maximum age. An agent that stops while the app is closed keeps its token
     * until then. Only the user can read its config file.
     */
    async prune(): Promise<void> {
        const now = this.now();
        await this.remove(entry => now - entry.createdAt > TOKEN_MAX_AGE_MS);
    }

    async savedPort(): Promise<number | undefined> {
        const port = (await this.store.get()).port;
        return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
    }

    async savePort(port: number): Promise<void> {
        await this.store.update(file => (file.port === port ? undefined : { ...file, port }));
    }

    private tokens(file: TokenFile): Record<string, TokenEntry> {
        return file.tokens && typeof file.tokens === 'object' ? file.tokens : {};
    }

    private async remove(match: (entry: TokenEntry) => boolean): Promise<void> {
        const removed: TokenEntry[] = [];
        await this.store.update(file => {
            const tokens = this.tokens(file);
            const kept = Object.fromEntries(
                Object.entries(tokens).filter(([, entry]) => {
                    if (!match(entry)) return true;
                    removed.push(entry);
                    return false;
                })
            );
            return removed.length > 0 ? { ...file, tokens: kept } : undefined;
        });
        await Promise.all(removed.map(entry => (entry.configFile ? fs.rm(entry.configFile, { force: true }).catch(() => undefined) : undefined)));
    }
}
