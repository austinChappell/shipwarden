import { initialOnboarding } from '@shared/onboarding';
import type { AppSettings } from '@shared/settings';

export interface OnboardingDependencies {
    settings: {
        get(): Promise<AppSettings>;
        update(change: Partial<AppSettings>): Promise<AppSettings>;
    };
    /** Returns true when a project has a repository. */
    hasRepos(): Promise<boolean>;
    /**
     * Returns the time (milliseconds since 1970) when the user started to use the app. For a current user without a saved
     * time, it is the creation time of the settings file. For a new user, it is now.
     */
    firstUseTime(): Promise<number>;
}

/**
 * Sets the first onboarding state one time, when the settings do not have one. Call it after the projects load.
 * A current user (with a repository) gets "done". A new user gets "new" and sees the welcome page.
 * It also saves the time of the first use one time, when the state does not have it.
 */
export async function ensureOnboarding(deps: OnboardingDependencies): Promise<void> {
    const { onboarding } = await deps.settings.get();
    if (!onboarding) {
        await deps.settings.update({ onboarding: initialOnboarding(await deps.hasRepos(), await deps.firstUseTime()) });
        return;
    }
    if (onboarding.firstUsedAt === undefined) {
        await deps.settings.update({ onboarding: { ...onboarding, firstUsedAt: await deps.firstUseTime() } });
    }
}
