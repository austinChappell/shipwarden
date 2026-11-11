import { describe, expect, it } from 'vitest';
import { calloutPosition, isOnScreen, shouldOfferTour, spotlightRect, TOUR_STEPS, TOUR_VERSION, tourKey, tourStep } from './tour';

const viewport = { width: 1200, height: 800 };
const callout = { width: 320, height: 180 };

describe('TOUR_STEPS', () => {
    it('has 6 to 8 steps with unique IDs', () => {
        expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(6);
        expect(TOUR_STEPS.length).toBeLessThanOrEqual(8);
        expect(new Set(TOUR_STEPS.map(step => step.id)).size).toBe(TOUR_STEPS.length);
    });

    it('ends with the step about quit, which needs no target', () => {
        expect(TOUR_STEPS.at(-1)?.id).toBe('quit');
        expect(TOUR_STEPS.at(-1)?.target).toBeUndefined();
        expect(TOUR_STEPS.at(-1)?.body).toContain('⇧⌥⌘Q');
    });

    it('never writes "some seconds" or "some minutes"', () => {
        for (const step of TOUR_STEPS) expect(`${step.title} ${step.body}`).not.toMatch(/some (seconds|minutes|days)/);
    });
});

describe('tourStep', () => {
    it('goes forward and back', () => {
        expect(tourStep(0, 8, 'next')).toBe(1);
        expect(tourStep(3, 8, 'back')).toBe(2);
    });

    it('stays on the first step for "back"', () => {
        expect(tourStep(0, 8, 'back')).toBe(0);
    });

    it('closes after the last step and on "close"', () => {
        expect(tourStep(7, 8, 'next')).toBe('close');
        expect(tourStep(2, 8, 'close')).toBe('close');
    });
});

describe('tourKey', () => {
    it('maps the keys of the tour', () => {
        expect(tourKey('ArrowRight')).toBe('next');
        expect(tourKey('Enter')).toBe('next');
        expect(tourKey('ArrowLeft')).toBe('back');
        expect(tourKey('Escape')).toBe('close');
        expect(tourKey('a')).toBeUndefined();
    });
});

describe('shouldOfferTour', () => {
    it('offers the tour to a user who has not seen it', () => {
        expect(shouldOfferTour({ welcome: 'done' }, false)).toBe(true);
        expect(shouldOfferTour({ welcome: 'skipped' }, false)).toBe(true);
    });

    it('does not offer it during the welcome page or after the user saw it', () => {
        expect(shouldOfferTour({ welcome: 'new' }, false)).toBe(false);
        expect(shouldOfferTour({ welcome: 'done' }, true)).toBe(false);
        expect(shouldOfferTour({ welcome: 'done', tourSeen: TOUR_VERSION }, false)).toBe(false);
        expect(shouldOfferTour(undefined, false)).toBe(false);
    });

    it('offers a newer tour version again', () => {
        expect(shouldOfferTour({ welcome: 'done', tourSeen: TOUR_VERSION - 1 }, false)).toBe(true);
    });
});

describe('isOnScreen', () => {
    it('needs a size and a part in the window', () => {
        expect(isOnScreen({ top: 10, left: 10, width: 100, height: 30 }, viewport)).toBe(true);
        expect(isOnScreen({ top: 10, left: 10, width: 0, height: 30 }, viewport)).toBe(false);
        expect(isOnScreen({ top: 10, left: 1300, width: 100, height: 30 }, viewport)).toBe(false);
        expect(isOnScreen(undefined, viewport)).toBe(false);
    });
});

describe('calloutPosition', () => {
    it('puts the callout at the right of a target at the left, for example the sidebar', () => {
        const position = calloutPosition({ top: 0, left: 0, width: 260, height: 800 }, callout, viewport);
        expect(position).toEqual({ top: 310, left: 272, placement: 'right' });
    });

    it('puts the callout at the left of a target at the right, for example the right panel', () => {
        const position = calloutPosition({ top: 40, left: 900, width: 300, height: 760 }, callout, viewport);
        expect(position.placement).toBe('left');
        expect(position.left).toBe(900 - 12 - 320);
    });

    it('puts the callout below a wide target at the top, for example the tab strip', () => {
        const position = calloutPosition({ top: 0, left: 0, width: 1200, height: 40 }, callout, viewport);
        expect(position).toMatchObject({ top: 52, placement: 'below' });
        expect(position.left).toBe(Math.round(600 - 160));
    });

    it('puts the callout above a wide target at the bottom', () => {
        expect(calloutPosition({ top: 760, left: 0, width: 1200, height: 40 }, callout, viewport)).toMatchObject({ placement: 'above', top: 760 - 12 - 180 });
    });

    it('keeps the callout in the window', () => {
        const position = calloutPosition({ top: 2, left: 0, width: 200, height: 20 }, callout, viewport);
        expect(position.top).toBeGreaterThanOrEqual(12);
    });

    it('uses the center when the target is not on the screen', () => {
        expect(calloutPosition(undefined, callout, viewport)).toEqual({ top: 310, left: 440, placement: 'center' });
        expect(calloutPosition({ top: 0, left: 0, width: 0, height: 0 }, callout, viewport).placement).toBe('center');
    });

    it('uses the center in a narrow window when the callout fits at no side', () => {
        const narrow = { width: 360, height: 300 };
        expect(calloutPosition({ top: 0, left: 0, width: 360, height: 300 }, callout, narrow).placement).toBe('center');
    });
});

describe('spotlightRect', () => {
    it('adds a padding and keeps the highlight in the window', () => {
        expect(spotlightRect({ top: 0, left: 10, width: 100, height: 20 }, viewport)).toEqual({ top: 0, left: 6, width: 108, height: 24 });
        expect(spotlightRect({ top: 790, left: 1150, width: 100, height: 20 }, viewport)).toEqual({ top: 786, left: 1146, width: 54, height: 14 });
    });
});
