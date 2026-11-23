import { describe, expect, it } from 'vitest';
import { geminiMcpSettings, isWriteTool, mcpConfig, normalizeApprovals, opencodeMcpServers } from './mcp';

describe('normalizeApprovals', () => {
    it('keeps the known write tools of absolute worktree paths', () => {
        expect(
            normalizeApprovals({
                '/w/a': ['set_task_status', 'ask_agent', 'ask_agent', 'list_worktrees', 3],
                'relative/b': ['ask_agent'],
                '/w/c': [],
                '/w/d': 'ask_agent'
            })
        ).toEqual({ '/w/a': ['ask_agent', 'set_task_status'] });
    });
    it('gives an empty object for a wrong value', () => {
        expect(normalizeApprovals(undefined)).toEqual({});
        expect(normalizeApprovals([])).toEqual({});
    });
});

describe('isWriteTool', () => {
    it('knows the write tools', () => {
        expect(isWriteTool('ask_agent')).toBe(true);
        expect(isWriteTool('set_task_status')).toBe(true);
        expect(isWriteTool('get_task')).toBe(false);
    });
});

describe('mcpConfig', () => {
    it('gives an HTTP server with the bearer token', () => {
        expect(mcpConfig('http://127.0.0.1:4000/mcp', 'abc')).toEqual({
            mcpServers: { shipwarden: { type: 'http', url: 'http://127.0.0.1:4000/mcp', headers: { Authorization: 'Bearer abc' } } }
        });
    });
});

describe('geminiMcpSettings', () => {
    it('adds the server to the hook settings, and the other servers and values stay', () => {
        const hookSettings = { hooks: { Stop: [] }, general: { vimMode: true }, mcpServers: { github: { command: 'gh-mcp' } } };
        expect(geminiMcpSettings(hookSettings, 'http://127.0.0.1:4000/mcp', 'abc')).toEqual({
            hooks: { Stop: [] },
            general: { vimMode: true },
            mcpServers: {
                github: { command: 'gh-mcp' },
                shipwarden: { httpUrl: 'http://127.0.0.1:4000/mcp', headers: { Authorization: 'Bearer abc' } }
            }
        });
        expect(hookSettings.mcpServers).toEqual({ github: { command: 'gh-mcp' } });
    });
    it('starts from an empty object for a value that is not an object', () => {
        expect(geminiMcpSettings(null, 'http://x/mcp', 'abc')).toEqual({
            mcpServers: { shipwarden: { httpUrl: 'http://x/mcp', headers: { Authorization: 'Bearer abc' } } }
        });
    });
});

describe('opencodeMcpServers', () => {
    it('gives a remote server that reads the token from the environment', () => {
        expect(opencodeMcpServers('http://x/mcp')).toEqual({
            shipwarden: { type: 'remote', url: 'http://x/mcp', enabled: true, headers: { Authorization: 'Bearer {env:SHIPWARDEN_MCP_TOKEN}' } }
        });
    });
});
