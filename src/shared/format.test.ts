import { describe, expect, it } from 'vitest';
import { ageTone, formatAge, formatAgo, pluralize } from './format';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatAge', () => {
    it('shows each unit without a space', () => {
        expect(formatAge(ago(20_000), NOW)).toBe('now');
        expect(formatAge(ago(12 * MIN), NOW)).toBe('12m');
        expect(formatAge(ago(7 * HOUR), NOW)).toBe('7h');
        expect(formatAge(ago(2 * DAY), NOW)).toBe('2d');
        expect(formatAge(ago(13 * DAY), NOW)).toBe('13d');
        expect(formatAge(ago(28 * DAY), NOW)).toBe('4w');
    });

    it('shows "now" for a date in the future', () => {
        expect(formatAge(ago(-5 * MIN), NOW)).toBe('now');
    });
});

describe('formatAgo', () => {
    it('adds "ago", and says "just now" for less than a minute', () => {
        expect(formatAgo(ago(7 * HOUR), NOW)).toBe('7h ago');
        expect(formatAgo(ago(10_000), NOW)).toBe('just now');
    });
});

describe('ageTone', () => {
    it('uses the 7-day and the 30-day limits', () => {
        expect(ageTone(ago(6 * DAY), NOW)).toBe('muted');
        expect(ageTone(ago(7 * DAY), NOW)).toBe('warning');
        expect(ageTone(ago(29 * DAY), NOW)).toBe('warning');
        expect(ageTone(ago(30 * DAY), NOW)).toBe('danger');
    });
});

describe('pluralize', () => {
    it('uses the singular only for 1', () => {
        expect(pluralize(1, 'pull request')).toBe('1 pull request');
        expect(pluralize(0, 'pull request')).toBe('0 pull requests');
        expect(pluralize(2, 'reply', 'replies')).toBe('2 replies');
    });
});
