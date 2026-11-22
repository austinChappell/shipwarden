import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpTokens, TOKEN_MAX_AGE_MS } from './tokens';

const folders: string[] = [];
function setup(now: () => number = Date.now) {
    const folder = mkdtempSync(join(tmpdir(), 'mcp-tokens-'));
    folders.push(folder);
    return { folder, tokens: new McpTokens(join(folder, 'tokens.json'), join(folder, 'configs'), now) };
}

afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));

describe('McpTokens', () => {
    it('issues a token for a worktree and writes a private MCP config file with it', async () => {
        const { folder, tokens } = setup();
        const issued = await tokens.issue('/w/a', 'http://127.0.0.1:4000/mcp');
        expect(await tokens.worktreeOf(issued.token)).toBe('/w/a');
        expect(await tokens.worktreeOf('wrong')).toBeUndefined();
        expect(await tokens.worktreeOf('')).toBeUndefined();
        const config = JSON.parse(readFileSync(issued.configFile, 'utf8'));
        expect(config.mcpServers.shipwarden).toEqual({ type: 'http', url: 'http://127.0.0.1:4000/mcp', headers: { Authorization: `Bearer ${issued.token}` } });
        expect(statSync(issued.configFile).mode & 0o777).toBe(0o600);
        // The token file keeps only the hash.
        expect(readFileSync(join(folder, 'tokens.json'), 'utf8')).not.toContain(issued.token);
    });

    it('gives each session its own token', async () => {
        const { tokens } = setup();
        const a = await tokens.issue('/w/a', 'http://x/mcp');
        const b = await tokens.issue('/w/b', 'http://x/mcp');
        expect(a.token).not.toBe(b.token);
        expect(await tokens.worktreeOf(b.token)).toBe('/w/b');
    });

    it('ends the token and removes the config file when the session exits', async () => {
        const { tokens } = setup();
        const issued = await tokens.issue('/w/a', 'http://x/mcp');
        await tokens.bindSession(issued.id, 'session-1');
        await tokens.revokeSession('session-2');
        expect(await tokens.worktreeOf(issued.token)).toBe('/w/a');
        await tokens.revokeSession('session-1');
        expect(await tokens.worktreeOf(issued.token)).toBeUndefined();
        expect(existsSync(issued.configFile)).toBe(false);
    });

    it('rejects and prunes a token that is older than the maximum age', async () => {
        let now = 1_000;
        const { tokens } = setup(() => now);
        const issued = await tokens.issue('/w/a', 'http://x/mcp');
        now += TOKEN_MAX_AGE_MS + 1;
        expect(await tokens.worktreeOf(issued.token)).toBeUndefined();
        await tokens.prune();
        expect(existsSync(issued.configFile)).toBe(false);
    });

    it('keeps the tokens and the port for the next app run', async () => {
        const { folder, tokens } = setup();
        const issued = await tokens.issue('/w/a', 'http://x/mcp');
        await tokens.savePort(52_000);
        const next = new McpTokens(join(folder, 'tokens.json'), join(folder, 'configs'));
        expect(await next.worktreeOf(issued.token)).toBe('/w/a');
        expect(await next.savedPort()).toBe(52_000);
    });
});
