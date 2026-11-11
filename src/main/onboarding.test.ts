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
        await ensureOnboarding({ settings, hasRepos: async () => false });
        expect((await settings.get()).onboarding).toEqual({ welcome: 'new' });
    });

    it('does not show the welcome page to a current user with a repository', async () => {
        const settings = store({ agents: [{ id: 'a', name: 'Aider', command: 'aider' }], defaultAgentId: 'a' });
        await ensureOnboarding({ settings, hasRepos: async () => true });
        const after = await settings.get();
        expect(after.onboarding).toEqual({ welcome: 'done' });
        expect(after.defaultAgentId).toBe('a');
    });

    it('does not change a state that exists', async () => {
        const settings = store({ onboarding: { welcome: 'skipped' } });
        await ensureOnboarding({ settings, hasRepos: async () => true });
        expect((await settings.get()).onboarding).toEqual({ welcome: 'skipped' });
        expect(settings.writes()).toBe(0);
    });
});
