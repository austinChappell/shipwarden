import type { OnboardingSettings } from './onboarding';

/** The GitHub page of the ShipWarden repository. */
export const PROJECT_URL = 'https://github.com/austinChappell/shipwarden';

/** The time from the first use of the app to the GitHub star notice: 5 days. */
export const STAR_PROMPT_DELAY_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * Returns true when the GitHub star notice can show. The user must use the app for 5 days or more. The notice does not
 * show before the welcome page is done, or after the user answered it.
 */
export function shouldShowStarPrompt(onboarding: OnboardingSettings | undefined, now: number): boolean {
    if (!onboarding || onboarding.welcome === 'new' || onboarding.starPromptDone) return false;
    return onboarding.firstUsedAt !== undefined && now - onboarding.firstUsedAt >= STAR_PROMPT_DELAY_MS;
}
