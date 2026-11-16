import { describe, expect, it } from 'vitest';
import { normalizeSettings, type AppSettings } from '@shared/settings';
import { ensureOnboarding } from './onboarding';

/** A settings store in memory. */
function store(initial: unknown) {
    let value = normalizeSettings(initial);
    let writes = 0;
    return {
        get: async () => value,
        update: async (change: Partial<AppSettings>) => {
            writes++;
            value = normalizeSettings({ ...value, ...change });
            return value;
        },
        writes: () => writes
    };
}

describe('ensureOnboarding', () => {
    it('shows the welcome page to a new user', async () => {
        const settings = store({});
        await ensureOnboarding({ settings, hasRepos: async () => false, firstUseTime: async () => 7 });
        expect((await settings.get()).onboarding).toEqual({ welcome: 'new', firstUsedAt: 7 });
    });

    it('does not show the welcome page to a current user with a repository', async () => {
        const settings = store({ agents: [{ id: 'a', name: 'Aider', command: 'aider' }], defaultAgentId: 'a' });
        await ensureOnboarding({ settings, hasRepos: async () => true, firstUseTime: async () => 7 });
        const after = await settings.get();
        expect(after.onboarding).toEqual({ welcome: 'done', checklistClosed: true, firstUsedAt: 7 });
        expect(after.defaultAgentId).toBe('a');
    });

    it('does not change a state that exists', async () => {
        const settings = store({ onboarding: { welcome: 'skipped', firstUsedAt: 3 } });
        await ensureOnboarding({ settings, hasRepos: async () => true, firstUseTime: async () => 7 });
        expect((await settings.get()).onboarding).toEqual({ welcome: 'skipped', firstUsedAt: 3 });
        expect(settings.writes()).toBe(0);
    });

    it('adds the first-use time to a state without one', async () => {
        const settings = store({ onboarding: { welcome: 'done', tipsOff: true } });
        await ensureOnboarding({ settings, hasRepos: async () => true, firstUseTime: async () => 7 });
        expect((await settings.get()).onboarding).toEqual({ welcome: 'done', tipsOff: true, firstUsedAt: 7 });
    });
});
