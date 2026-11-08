import { describe, expect, it } from 'vitest';
import { ciChanges, DEFAULT_NOTIFICATION_SETTINGS, normalizeNotificationSettings } from './notifications';

describe('normalizeNotificationSettings', () => {
    it('gives the defaults and keeps valid values', () => {
        expect(normalizeNotificationSettings(undefined)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
        const settings = normalizeNotificationSettings({
            enabled: false,
            whenFocused: false,
            events: { agentWaiting: { enabled: false, sound: 'Ping' }, agentDone: { sound: 'NotASound' }, ciFinished: { sound: null } }
        });
        expect(settings.enabled).toBe(false);
        expect(settings.whenFocused).toBe(false);
        expect(settings.events.agentWaiting).toEqual({ enabled: false, sound: 'Ping' });
        expect(settings.events.agentDone).toEqual({ enabled: true, sound: null });
        expect(settings.events.ciFinished).toEqual({ enabled: true, sound: null });
        expect(settings.events.dashboard).toEqual(DEFAULT_NOTIFICATION_SETTINGS.events.dashboard);
    });
});

describe('ciChanges', () => {
    const pr = (checks: string | null, number = 7) => ({ number, url: 'u', isDraft: false, reviewDecision: null, checks });

    it('finds checks that went from waiting to a result', () => {
        expect(ciChanges({ a: pr('PENDING'), b: pr('EXPECTED'), c: pr('PENDING') }, { a: pr('SUCCESS'), b: pr('FAILURE'), c: pr('PENDING') })).toEqual([
            { branch: 'a', summary: pr('SUCCESS'), passed: true },
            { branch: 'b', summary: pr('FAILURE'), passed: false }
        ]);
    });

    it('ignores the first load, a new pull request, and a result without a change', () => {
        expect(ciChanges(undefined, { a: pr('SUCCESS') })).toEqual([]);
        expect(ciChanges({ a: pr('PENDING', 1) }, { a: pr('SUCCESS', 2) })).toEqual([]);
        expect(ciChanges({ a: pr('SUCCESS') }, { a: pr('SUCCESS') })).toEqual([]);
    });
});
