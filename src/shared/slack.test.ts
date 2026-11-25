import { describe, expect, it } from 'vitest';
import { isAppToken, isBotToken, normalizeSlackSettings, parseSlackUserIds } from './slack';

describe('parseSlackUserIds', () => {
    it('reads IDs with commas, spaces, and mentions, without duplicates', () => {
        expect(parseSlackUserIds('U012AB3CD, w99zz\n<@U012AB3CD>  ')).toEqual({ ids: ['U012AB3CD', 'W99ZZ'], invalid: [] });
    });

    it('returns the values that are not member IDs', () => {
        expect(parseSlackUserIds('U1A2B3 alice C0123')).toEqual({ ids: ['U1A2B3'], invalid: ['alice', 'C0123'] });
    });
});

describe('normalizeSlackSettings', () => {
    it('gives the defaults for a missing value', () => {
        expect(normalizeSlackSettings(undefined)).toEqual({ enabled: false, allowedUserIds: [] });
    });

    it('keeps valid values and drops invalid ones', () => {
        expect(normalizeSlackSettings({ enabled: true, channelId: 'C0123ABCD', channelName: ' agents ', allowedUserIds: ['U012AB3CD', 'bad', 7] })).toEqual({
            enabled: true,
            channelId: 'C0123ABCD',
            channelName: 'agents',
            allowedUserIds: ['U012AB3CD']
        });
        expect(normalizeSlackSettings({ channelId: 'general', channelName: 'general' })).toEqual({ enabled: false, allowedUserIds: [] });
    });
});

describe('token checks', () => {
    it('knows the two token types', () => {
        expect(isBotToken('xoxb-1234-5678-abcdef')).toBe(true);
        expect(isBotToken('xapp-1-A1-2-abcdef')).toBe(false);
        expect(isAppToken('xapp-1-A1234-5678-abcdef')).toBe(true);
        expect(isAppToken('xapp-1 space')).toBe(false);
    });
});
