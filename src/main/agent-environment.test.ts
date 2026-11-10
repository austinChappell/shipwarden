import { describe, expect, it } from 'vitest';
import { removeAgentSessionVariables } from './agent-environment';

describe('removeAgentSessionVariables', () => {
    it('removes the session markers and keeps the user settings', () => {
        const env: NodeJS.ProcessEnv = {
            CLAUDECODE: '1',
            CLAUDE_CODE_CHILD_SESSION: '1',
            CLAUDE_CODE_SESSION_ID: 'abc',
            CLAUDE_CODE_USE_BEDROCK: '1',
            ANTHROPIC_API_KEY: 'key',
            PATH: '/usr/bin'
        };

        const removed = removeAgentSessionVariables(env);

        expect(removed.sort()).toEqual(['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID']);
        expect(env).toEqual({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'key', PATH: '/usr/bin' });
    });
});
