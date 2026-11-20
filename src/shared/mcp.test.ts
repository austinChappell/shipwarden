import { describe, expect, it } from 'vitest';
import { isWriteTool, mcpConfig, normalizeApprovals } from './mcp';

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
