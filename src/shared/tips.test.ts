import { describe, expect, it } from 'vitest';
import {
    closeInlineTip,
    INLINE_TIPS,
    inlineTipShows,
    NOTICE_TIPS,
    pickTip,
    RECENT_TIP_COUNT,
    rememberTip,
    shouldShowTipNotice,
    TIP_INTERVAL_MS,
    tipsOn
} from './tips';

const allTips = [...NOTICE_TIPS, ...Object.values(INLINE_TIPS)];

describe('NOTICE_TIPS', () => {
    it('has about 20 tips with unique IDs', () => {
        expect(NOTICE_TIPS.length).toBeGreaterThanOrEqual(18);
        expect(new Set(NOTICE_TIPS.map(tip => tip.id)).size).toBe(NOTICE_TIPS.length);
    });

    it('never writes "some seconds", "some minutes" or "some days"', () => {
        for (const tip of allTips) expect(`${tip.title} ${tip.body}`).not.toMatch(/some (seconds|minutes|days)/);
    });

    it('uses no semicolons', () => {
        for (const tip of allTips) expect(`${tip.title} ${tip.body}`).not.toContain(';');
    });
});

describe('tipsOn', () => {
    it('is on by default and off after the user turns it off', () => {
        expect(tipsOn(undefined)).toBe(true);
        expect(tipsOn({ welcome: 'done' })).toBe(true);
        expect(tipsOn({ welcome: 'done', tipsOff: true })).toBe(false);
    });
});

describe('shouldShowTipNotice', () => {
    const now = 1_800_000_000_000;

    it('shows at each start of the app', () => {
        expect(shouldShowTipNotice({ welcome: 'done' }, true, now)).toBe(true);
        expect(shouldShowTipNotice({ welcome: 'skipped', tipClosedAt: now - 1000 }, true, now)).toBe(true);
    });

    it('shows again 12 hours after the user closed the last tip, while the app stays open', () => {
        expect(shouldShowTipNotice({ welcome: 'done' }, false, now)).toBe(false);
        expect(shouldShowTipNotice({ welcome: 'done', tipClosedAt: now - TIP_INTERVAL_MS + 1 }, false, now)).toBe(false);
        expect(shouldShowTipNotice({ welcome: 'done', tipClosedAt: now - TIP_INTERVAL_MS }, false, now)).toBe(true);
    });

    it('does not show before the onboarding state loads, during the welcome page or when the tips are off', () => {
        expect(shouldShowTipNotice(undefined, true, now)).toBe(false);
        expect(shouldShowTipNotice({ welcome: 'new' }, true, now)).toBe(false);
        expect(shouldShowTipNotice({ welcome: 'done', tipsOff: true }, true, now)).toBe(false);
    });
});

describe('inlineTipShows', () => {
    it('shows until the user closes the tip or turns off the tips', () => {
        expect(inlineTipShows(undefined, 'dashboard')).toBe(true);
        expect(inlineTipShows({ welcome: 'done', tipsClosed: ['tasks'] }, 'dashboard')).toBe(true);
        expect(inlineTipShows({ welcome: 'done', tipsClosed: ['dashboard'] }, 'dashboard')).toBe(false);
        expect(inlineTipShows({ welcome: 'done', tipsOff: true }, 'dashboard')).toBe(false);
    });
});

describe('closeInlineTip', () => {
    it('adds the tip one time', () => {
        expect(closeInlineTip(undefined, 'dashboard')).toEqual(['dashboard']);
        expect(closeInlineTip(['tasks'], 'dashboard')).toEqual(['tasks', 'dashboard']);
        expect(closeInlineTip(['dashboard'], 'dashboard')).toEqual(['dashboard']);
    });
});

describe('pickTip', () => {
    it('picks a tip from the random number', () => {
        expect(pickTip(undefined, () => 0)).toBe(0);
        expect(pickTip(undefined, () => 0.999999)).toBe(NOTICE_TIPS.length - 1);
    });

    it('does not pick a recent tip', () => {
        const recent = NOTICE_TIPS.slice(0, RECENT_TIP_COUNT).map(tip => tip.id);
        for (const value of [0, 0.3, 0.6, 0.999999]) expect(pickTip(recent, () => value)).toBeGreaterThanOrEqual(RECENT_TIP_COUNT);
    });

    it('never shows the same tip twice within 10 notices', () => {
        let recent: string[] = [];
        const shown: string[] = [];
        for (let count = 0; count < 200; count++) {
            const id = NOTICE_TIPS[pickTip(recent)].id;
            shown.push(id);
            recent = rememberTip(recent, id);
        }
        for (let start = 0; start + 10 <= shown.length; start++) expect(new Set(shown.slice(start, start + 10)).size).toBe(10);
    });
});

describe('rememberTip', () => {
    it('keeps the newest IDs, the newest last', () => {
        expect(rememberTip(undefined, 'quit')).toEqual(['quit']);
        const full = NOTICE_TIPS.slice(0, RECENT_TIP_COUNT).map(tip => tip.id);
        expect(rememberTip(full, 'phone')).toEqual([...full.slice(1), 'phone']);
    });
});
