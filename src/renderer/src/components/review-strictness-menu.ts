import { REVIEW_STRICTNESS_LEVELS, REVIEW_STRICTNESS_TEXT, type ReviewStrictness } from '@shared/review-strictness';
import type { SplitMenuItem } from './ui';

/** The tooltip of the arrow button that opens the strictness menu. */
export const STRICTNESS_MENU_TITLE = 'Select how strict the agent review is';

/**
 * Returns the menu items that start an agent review with one strictness level. The item of the default level has
 * "(default)" after its name.
 */
export function strictnessMenuItems(defaultLevel: ReviewStrictness | undefined, run: (level: ReviewStrictness) => void, disabled = false): SplitMenuItem[] {
    return REVIEW_STRICTNESS_LEVELS.map(level => ({
        label: `${REVIEW_STRICTNESS_TEXT[level].label} review${level === defaultLevel ? ' (default)' : ''}`,
        title: REVIEW_STRICTNESS_TEXT[level].description,
        disabled,
        onSelect: () => run(level)
    }));
}

/** Returns the tooltip of the main review button, with the default level when it is known. */
export function strictnessTitle(base: string, defaultLevel: ReviewStrictness | undefined): string {
    return defaultLevel ? `${base} Strictness: ${REVIEW_STRICTNESS_TEXT[defaultLevel].label}.` : base;
}
