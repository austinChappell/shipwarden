import { describe, expect, it } from 'vitest';
import { hookSettingsPaths } from './hook-files';

describe('hookSettingsPaths', () => {
    it('puts the hook files in the app data folder', () => {
        expect(hookSettingsPaths('/data')).toEqual({
            claude: '/data/claude-hooks.json',
            gemini: '/data/gemini-hooks.json',
            opencode: '/data/opencode/shipwarden-agent-state.js'
        });
    });
});
