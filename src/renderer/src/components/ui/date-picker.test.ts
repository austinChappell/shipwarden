import { describe, expect, it } from 'vitest';
import { addMonths, dayKey, monthGrid, parseDayKey } from './DatePicker';

describe('DatePicker', () => {
    it('reads and writes a day in the local time zone', () => {
        expect(dayKey(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
        expect(parseDayKey('2026-02-28')?.getDate()).toBe(28);
        expect(parseDayKey('2026-02-30')).toBeUndefined();
        expect(parseDayKey('soon')).toBeUndefined();
    });

    it('keeps the last day of a shorter month', () => {
        expect(dayKey(addMonths(new Date(2026, 0, 31), 1))).toBe('2026-02-28');
        expect(dayKey(addMonths(new Date(2026, 0, 15), -1))).toBe('2025-12-15');
    });

    it('starts the grid on the first day of the week', () => {
        // November 1, 2026 is a Sunday.
        const sunday = monthGrid(2026, 10, 0);
        expect(sunday).toHaveLength(42);
        expect(dayKey(sunday[0])).toBe('2026-11-01');
        const monday = monthGrid(2026, 10, 1);
        expect(dayKey(monday[0])).toBe('2026-10-26');
        expect(dayKey(monday[6])).toBe('2026-11-01');
    });
});
