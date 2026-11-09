import { describe, expect, it } from 'vitest';
import { EMPTY_NAV_HISTORY, NAV_HISTORY_LIMIT, recordLocation, stepHistory, type NavHistory, type NavLocation } from './nav-history';

const at = (tab: string): NavLocation => ({ view: 'worktree', worktree: '/repo', tab });
const build = (...tabs: string[]): NavHistory => tabs.reduce((history, tab) => recordLocation(history, at(tab)), EMPTY_NAV_HISTORY);
const always = () => true;

describe('recordLocation', () => {
    it('adds new locations and ignores the current location', () => {
        const history = recordLocation(build('a', 'b'), at('b'));
        expect(history.entries.map(entry => entry.tab)).toEqual(['a', 'b']);
        expect(history.index).toBe(1);
    });

    it('removes the forward entries', () => {
        const back = stepHistory(build('a', 'b', 'c'), -1, always)!.history;
        const history = recordLocation(back, at('d'));
        expect(history.entries.map(entry => entry.tab)).toEqual(['a', 'b', 'd']);
        expect(history.index).toBe(2);
    });

    it('keeps the newest entries only', () => {
        let history = EMPTY_NAV_HISTORY;
        for (let i = 0; i < NAV_HISTORY_LIMIT + 5; i++) history = recordLocation(history, at(String(i)));
        expect(history.entries).toHaveLength(NAV_HISTORY_LIMIT);
        expect(history.entries[0].tab).toBe('5');
        expect(history.index).toBe(NAV_HISTORY_LIMIT - 1);
    });

    it('records other views without a worktree', () => {
        const history = recordLocation(build('a'), { view: 'dashboard' });
        expect(history.entries[1]).toEqual({ view: 'dashboard' });
    });
});

describe('stepHistory', () => {
    it('goes back and forward', () => {
        const back = stepHistory(build('a', 'b', 'c'), -1, always)!;
        expect(back.location.tab).toBe('b');
        const forward = stepHistory(back.history, 1, always)!;
        expect(forward.location.tab).toBe('c');
        expect(forward.history.index).toBe(2);
    });

    it('returns undefined at the start and at the end', () => {
        expect(stepHistory(build('a', 'b'), 1, always)).toBeUndefined();
        expect(stepHistory(EMPTY_NAV_HISTORY, -1, always)).toBeUndefined();
        const start = stepHistory(build('a', 'b'), -1, always)!;
        expect(stepHistory(start.history, -1, always)).toBeUndefined();
    });

    it('skips entries that are not valid', () => {
        const back = stepHistory(build('a', 'closed', 'c'), -1, location => location.tab !== 'closed')!;
        expect(back.location.tab).toBe('a');
        expect(back.history.index).toBe(0);
    });

    it('skips entries that are the same as the current location', () => {
        // "b" closed, so the history has "a" next to "a".
        const back = stepHistory(build('a', 'b', 'a'), -1, location => location.tab !== 'b');
        expect(back).toBeUndefined();
    });
});
