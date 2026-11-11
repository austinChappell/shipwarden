import { initialOnboarding } from '@shared/onboarding';
import type { AppSettings } from '@shared/settings';

export interface OnboardingDependencies {
    settings: {
        get(): Promise<AppSettings>;
        update(change: Partial<AppSettings>): Promise<AppSettings>;
    };
    /** Returns true when a project has a repository. */
    hasRepos(): Promise<boolean>;
}

/**
 * Sets the first onboarding state one time, when the settings do not have one. Call it after the projects load.
 * A current user (with a repository) gets "done". A new user gets "new" and sees the welcome page.
 */
export async function ensureOnboarding(deps: OnboardingDependencies): Promise<void> {
    if ((await deps.settings.get()).onboarding) return;
    await deps.settings.update({ onboarding: initialOnboarding(await deps.hasRepos()) });
}
