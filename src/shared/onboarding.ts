/**
 * The onboarding state of the user: the welcome page, the tour and the getting started checklist.
 * The main process keeps it in `settings.json`, so all windows see the same state and a cache clear does not reset it.
 */
export interface OnboardingSettings {
    /** 'new' shows the welcome page. 'done' and 'skipped' do not. */
    welcome: OnboardingWelcome;
    /** The tour version that the user finished or closed. A new tour version can offer itself again. */
    tourSeen?: number;
    /** The checklist steps that are done, by step ID. */
    checklist?: Record<string, boolean>;
    /** True when the user closed the checklist card. The card does not show again. */
    checklistClosed?: boolean;
}

export type OnboardingWelcome = 'new' | 'done' | 'skipped';

const WELCOME_VALUES: readonly OnboardingWelcome[] = ['new', 'done', 'skipped'];

/**
 * Converts a stored value to a valid onboarding state. Returns undefined when the value is missing, because only the main
 * process knows if the user has repositories (see `initialOnboarding`).
 * A wrong `welcome` value becomes 'done', so that bad data never shows the welcome page to a current user.
 * A wrong optional value goes away.
 */
export function normalizeOnboarding(raw: unknown): OnboardingSettings | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const value = raw as Record<string, unknown>;
    const welcome = WELCOME_VALUES.includes(value.welcome as OnboardingWelcome) ? (value.welcome as OnboardingWelcome) : 'done';
    const result: OnboardingSettings = { welcome };
    if (typeof value.tourSeen === 'number' && Number.isInteger(value.tourSeen) && value.tourSeen > 0) {
        result.tourSeen = value.tourSeen;
    }
    const checklist = normalizeChecklist(value.checklist);
    if (checklist) result.checklist = checklist;
    if (value.checklistClosed === true) result.checklistClosed = true;
    return result;
}

/** Keeps the checklist steps that are done. A step ID must be text. A step that is not done goes away. */
function normalizeChecklist(raw: unknown): Record<string, boolean> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const entries = Object.entries(raw as Record<string, unknown>).filter(([id, done]) => id.length > 0 && done === true);
    return entries.length > 0 ? Object.fromEntries(entries.map(([id]) => [id, true])) : undefined;
}

/**
 * Returns the first onboarding state of a user without one.
 * A current user (with a repository) does not see the welcome page. A new user (without a repository) sees it.
 */
export function initialOnboarding(hasRepos: boolean): OnboardingSettings {
    return { welcome: hasRepos ? 'done' : 'new' };
}

/** The items of the Help menu that the page handles: the welcome page, the tour and the keyboard shortcuts. */
export type HelpAction = 'welcome' | 'tour' | 'shortcuts';
