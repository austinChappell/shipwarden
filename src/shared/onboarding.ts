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
    /** True when the user turned off the tips. The tips are on by default. */
    tipsOff?: boolean;
    /** The IDs of the inline tips that the user closed. A closed inline tip does not show again. */
    tipsClosed?: string[];
    /** The IDs of the last tips that the corner notice showed, the newest last. The notice does not show them again soon. */
    recentTips?: string[];
    /** The time (milliseconds since 1970) when the user closed the last tip notice. The next notice shows 12 hours later. */
    tipClosedAt?: number;
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
    if (value.tipsOff === true) result.tipsOff = true;
    if (Array.isArray(value.tipsClosed)) {
        const closed = [...new Set(value.tipsClosed.filter((id): id is string => typeof id === 'string' && id.length > 0))];
        if (closed.length > 0) result.tipsClosed = closed;
    }
    if (Array.isArray(value.recentTips)) {
        const recent = value.recentTips.filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (recent.length > 0) result.recentTips = recent;
    }
    if (typeof value.tipClosedAt === 'number' && Number.isFinite(value.tipClosedAt) && value.tipClosedAt > 0) result.tipClosedAt = value.tipClosedAt;
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
 * A current user (with a repository) does not see the welcome page or the checklist. A new user (without a repository)
 * sees both.
 */
export function initialOnboarding(hasRepos: boolean): OnboardingSettings {
    return hasRepos ? { welcome: 'done', checklistClosed: true } : { welcome: 'new' };
}

/** The items of the Help menu that the page handles: the welcome page, the tour and the keyboard shortcuts. */
export type HelpAction = 'welcome' | 'tour' | 'shortcuts';

/**
 * Returns the onboarding state with a change, for `settings.update`. The settings store replaces the full object, so the
 * other values must stay. A missing state counts as 'done'.
 */
export function changeOnboarding(current: OnboardingSettings | undefined, change: Partial<OnboardingSettings>): OnboardingSettings {
    return { ...(current ?? { welcome: 'done' }), ...change };
}
