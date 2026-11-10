import { describe, expect, it } from 'vitest';
import { formatResetIn, highestWindow, parseClaudeUsage, parseCodexUsage, resetTime } from './usage';

describe('parseClaudeUsage', () => {
    it('reads the 5-hour, weekly and model limits', () => {
        const windows = parseClaudeUsage({
            five_hour: { utilization: 7.4, resets_at: '2026-11-07T12:00:00.000Z' },
            seven_day: { utilization: 15, resets_at: '2026-11-08T12:00:00+00:00' },
            seven_day_oauth_apps: null,
            seven_day_opus: { utilization: 3, resets_at: null },
            limits: [{ kind: 'weekly_scoped', percent: 0, resets_at: '2026-11-10T00:00:00Z', scope: { model: { display_name: 'Fable' } } }]
        });
        expect(windows).toEqual([
            { kind: 'session', label: '5h', usedPercent: 7, resetsAt: '2026-11-07T12:00:00.000Z' },
            { kind: 'weekly', label: 'Weekly', usedPercent: 15, resetsAt: '2026-11-08T12:00:00.000Z' },
            { kind: 'model', label: 'Fable', usedPercent: 0, resetsAt: '2026-11-10T00:00:00.000Z' },
            { kind: 'model', label: 'Opus', usedPercent: 3, resetsAt: undefined }
        ]);
    });

    it('does not count a model twice and ignores bad values', () => {
        expect(
            parseClaudeUsage({
                seven_day_fable: { utilization: 9 },
                limits: [{ kind: 'weekly_scoped', percent: 4, scope: { model: { display_name: 'Fable' } } }, null, { kind: 'other' }],
                five_hour: { utilization: 'x' }
            })
        ).toEqual([{ kind: 'model', label: 'Fable', usedPercent: 4, resetsAt: undefined }]);
        expect(parseClaudeUsage(null)).toEqual([]);
    });
});

describe('parseCodexUsage', () => {
    it('reads the session and weekly windows and the plan', () => {
        const result = parseCodexUsage({
            plan_type: 'pro',
            rate_limit: {
                primary_window: { used_percent: 25, limit_window_seconds: 604800, reset_at: 1_794_000_000 },
                secondary_window: { used_percent: 4.4, limit_window_seconds: 18000, reset_at: 1_793_500_000 }
            }
        });
        expect(result.plan).toBe('pro');
        expect(result.windows).toEqual([
            { kind: 'session', label: '5h', usedPercent: 4, resetsAt: new Date(1_793_500_000_000).toISOString() },
            { kind: 'weekly', label: 'Weekly', usedPercent: 25, resetsAt: new Date(1_794_000_000_000).toISOString() }
        ]);
    });

    it('returns no windows for an unknown body', () => {
        expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 'x' } } }).windows).toEqual([]);
    });
});

describe('helpers', () => {
    it('reads seconds, milliseconds and ISO reset times', () => {
        expect(resetTime(1_794_000_000)).toBe(resetTime(1_794_000_000_000));
        expect(resetTime('not a date')).toBeUndefined();
        expect(resetTime(0)).toBeUndefined();
    });

    it('formats the time until a reset', () => {
        const now = Date.parse('2026-11-07T00:00:00Z');
        expect(formatResetIn('2026-11-07T00:12:00Z', now)).toBe('12m');
        expect(formatResetIn('2026-11-07T04:06:00Z', now)).toBe('4h 6m');
        expect(formatResetIn('2026-11-08T03:10:00Z', now)).toBe('1d 3h');
        expect(formatResetIn('2026-11-06T00:00:00Z', now)).toBe('0m');
        expect(formatResetIn(undefined, now)).toBeUndefined();
    });

    it('finds the window nearest to its limit', () => {
        expect(
            highestWindow([
                { kind: 'session', label: '5h', usedPercent: 7 },
                { kind: 'weekly', label: 'Weekly', usedPercent: 15 }
            ])?.label
        ).toBe('Weekly');
        expect(highestWindow([])).toBeUndefined();
    });
});
