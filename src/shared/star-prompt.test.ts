import { describe, expect, it } from 'vitest';
import { shouldShowStarPrompt, STAR_PROMPT_DELAY_MS } from './star-prompt';

const start = 1_700_000_000_000;

describe('shouldShowStarPrompt', () => {
    it('shows 5 days after the first use', () => {
        const onboarding = { welcome: 'done' as const, firstUsedAt: start };
        expect(shouldShowStarPrompt(onboarding, start + STAR_PROMPT_DELAY_MS - 1)).toBe(false);
        expect(shouldShowStarPrompt(onboarding, start + STAR_PROMPT_DELAY_MS)).toBe(true);
    });

    it('does not show after the user answered it', () => {
        expect(shouldShowStarPrompt({ welcome: 'done', firstUsedAt: start, starPromptDone: true }, start + STAR_PROMPT_DELAY_MS)).toBe(false);
    });

    it('does not show before the welcome page is done', () => {
        expect(shouldShowStarPrompt({ welcome: 'new', firstUsedAt: start }, start + STAR_PROMPT_DELAY_MS)).toBe(false);
    });

    it('does not show without a first-use time', () => {
        expect(shouldShowStarPrompt(undefined, start)).toBe(false);
        expect(shouldShowStarPrompt({ welcome: 'done' }, start + STAR_PROMPT_DELAY_MS)).toBe(false);
    });
});
