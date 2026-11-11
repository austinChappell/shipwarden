import { describe, expect, it } from 'vitest';
import { changeOnboarding, initialOnboarding, normalizeOnboarding } from './onboarding';

describe('normalizeOnboarding', () => {
    it('returns undefined for a missing value, so the main process can set the first state', () => {
        expect(normalizeOnboarding(undefined)).toBeUndefined();
        expect(normalizeOnboarding(null)).toBeUndefined();
        expect(normalizeOnboarding('new')).toBeUndefined();
        expect(normalizeOnboarding([])).toBeUndefined();
    });

    it('keeps a valid state', () => {
        const state = { welcome: 'skipped', tourSeen: 2, checklist: { addRepository: true, startAgent: true }, checklistClosed: true };
        expect(normalizeOnboarding(state)).toEqual(state);
        expect(normalizeOnboarding({ welcome: 'new' })).toEqual({ welcome: 'new' });
    });

    it('changes a wrong welcome value to "done", so bad data does not show the welcome page', () => {
        expect(normalizeOnboarding({ welcome: 'started' })).toEqual({ welcome: 'done' });
        expect(normalizeOnboarding({})).toEqual({ welcome: 'done' });
        expect(normalizeOnboarding({ welcome: 1, tourSeen: 1 })).toEqual({ welcome: 'done', tourSeen: 1 });
    });

    it('removes wrong optional values', () => {
        expect(normalizeOnboarding({ welcome: 'done', tourSeen: 0, checklistClosed: 'yes', checklist: 'all' })).toEqual({ welcome: 'done' });
        expect(normalizeOnboarding({ welcome: 'done', tourSeen: 1.5 })).toEqual({ welcome: 'done' });
        expect(normalizeOnboarding({ welcome: 'done', tourSeen: -1 })).toEqual({ welcome: 'done' });
        expect(normalizeOnboarding({ welcome: 'done', checklistClosed: false })).toEqual({ welcome: 'done' });
    });

    it('keeps the tip state and removes wrong tip values', () => {
        const tips = { welcome: 'done', tipsOff: true, tipsClosed: ['dashboard'], recentTips: ['automations', 'quit'], tipClosedAt: 1_800_000_000_000 };
        expect(normalizeOnboarding(tips)).toEqual(tips);
        expect(normalizeOnboarding({ welcome: 'done', tipsOff: 'yes', tipsClosed: 'dashboard', recentTips: [1, ''], tipClosedAt: 'now' })).toEqual({
            welcome: 'done'
        });
        expect(normalizeOnboarding({ welcome: 'done', tipsOff: false, tipsClosed: [] })).toEqual({ welcome: 'done' });
        expect(normalizeOnboarding({ welcome: 'done', tipsClosed: ['tasks', 1, '', 'tasks'] })).toEqual({ welcome: 'done', tipsClosed: ['tasks'] });
    });

    it('keeps only the checklist steps that are done', () => {
        expect(normalizeOnboarding({ welcome: 'done', checklist: { addRepository: true, startAgent: false, openAgents: 'true' } })).toEqual({
            welcome: 'done',
            checklist: { addRepository: true }
        });
        expect(normalizeOnboarding({ welcome: 'done', checklist: { startAgent: false } })).toEqual({ welcome: 'done' });
        expect(normalizeOnboarding({ welcome: 'done', checklist: [true] })).toEqual({ welcome: 'done' });
    });
});

describe('initialOnboarding', () => {
    it('shows the welcome page only to a user without repositories', () => {
        expect(initialOnboarding(false)).toEqual({ welcome: 'new' });
        expect(initialOnboarding(true)).toEqual({ welcome: 'done', checklistClosed: true });
    });
});

describe('changeOnboarding', () => {
    it('keeps the other values', () => {
        expect(changeOnboarding({ welcome: 'new', tourSeen: 1 }, { welcome: 'skipped' })).toEqual({ welcome: 'skipped', tourSeen: 1 });
    });

    it('treats a missing state as "done"', () => {
        expect(changeOnboarding(undefined, { tourSeen: 1 })).toEqual({ welcome: 'done', tourSeen: 1 });
    });
});
