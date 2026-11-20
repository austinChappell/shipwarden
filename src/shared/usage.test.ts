import { describe, expect, it } from 'vitest';
import {
    agentBudgetBlock,
    BUDGET_WAIT,
    budgetBlock,
    budgetWaitText,
    formatResetIn,
    highestWindow,
    normalizeUsageBudget,
    parseClaudeUsage,
    parseCodexUsage,
    resetTime,
    usageCrossings,
    usageProviderOf,
    usageSlots,
    type ProviderUsage,
    type UsageBudget
} from './usage';

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

describe('usage budget', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    const sessionReset = '2026-11-20T14:30:00.000Z';
    const weeklyReset = '2026-11-23T09:00:00.000Z';
    const claude = (session: number, weekly = 10): ProviderUsage[] => [
        {
            provider: 'claude',
            status: 'ok',
            windows: [
                { kind: 'session', label: '5h', usedPercent: session, resetsAt: sessionReset },
                { kind: 'weekly', label: 'Weekly', usedPercent: weekly, resetsAt: weeklyReset }
            ]
        }
    ];
    const budget: UsageBudget = { percent: 80, windows: 'all' };

    it('lets an agent start below the limit', () => {
        expect(budgetBlock(claude(79), budget, 'claude', now)).toBeUndefined();
    });

    it('stops an agent at the limit', () => {
        expect(budgetBlock(claude(80), budget, 'claude', now)).toEqual({
            provider: 'claude',
            percent: 80,
            window: { kind: 'session', label: '5h', usedPercent: 80, resetsAt: sessionReset }
        });
    });

    it('stops an agent above the limit', () => {
        expect(budgetBlock(claude(93), budget, 'claude', now)?.window.label).toBe('5h');
    });

    it('lets an agent start with no usage data', () => {
        expect(budgetBlock([], budget, 'claude', now)).toBeUndefined();
        expect(budgetBlock([{ provider: 'claude', status: 'signed-out', windows: [] }], budget, 'claude', now)).toBeUndefined();
        // An error keeps the last values. They are old, so they do not stop a start.
        expect(budgetBlock([{ ...claude(95)[0], status: 'error' }], budget, 'claude', now)).toBeUndefined();
        // An agent without a usage provider, for example Gemini CLI.
        expect(budgetBlock(claude(95), budget, undefined, now)).toBeUndefined();
    });

    it('lets an agent start when the budget is off or the usage is of another provider', () => {
        expect(budgetBlock(claude(100), { percent: null, windows: 'all' }, 'claude', now)).toBeUndefined();
        expect(budgetBlock(claude(100), budget, 'codex', now)).toBeUndefined();
    });

    it('ignores a window whose reset time passed', () => {
        expect(budgetBlock(claude(95), budget, 'claude', Date.parse('2026-11-20T15:00:00Z'))).toBeUndefined();
    });

    it('checks only the 5-hour limit when the setting says so', () => {
        expect(budgetBlock(claude(10, 90), budget, 'claude', now)?.window.label).toBe('Weekly');
        expect(budgetBlock(claude(10, 90), { percent: 80, windows: 'session' }, 'claude', now)).toBeUndefined();
    });

    it('waits for the window that resets last', () => {
        expect(budgetBlock(claude(90, 90), budget, 'claude', now)?.window.label).toBe('Weekly');
    });

    it('finds the provider of each agent command', () => {
        expect(usageProviderOf('claude')).toBe('claude');
        expect(usageProviderOf('gemini')).toBeUndefined();
        expect(agentBudgetBlock(claude(90), budget, ['gemini', 'claude --model opus'], now)?.provider).toBe('claude');
        expect(agentBudgetBlock(claude(90), budget, ['gemini', 'codex'], now)).toBeUndefined();
    });

    it('writes the wait text with the reset time', () => {
        const block = budgetBlock(claude(85), budget, 'claude', now);
        if (!block) throw new Error('The budget did not stop the start.');
        const text = budgetWaitText(block, now);
        expect(text.startsWith(`${BUDGET_WAIT}. Claude (5h) is at 85%, and the budget is 80%. It resets at `)).toBe(true);
        expect(text.endsWith('(in 2h 30m).')).toBe(true);
        // Without the time now, the text has the clock time only, so a saved text does not change each minute.
        expect(budgetWaitText(block)).not.toContain('(in ');
        expect(budgetWaitText({ ...block, window: { ...block.window, resetsAt: undefined } })).toMatch(/The reset time is not known\.$/);
    });

    it('normalizes a stored budget', () => {
        expect(normalizeUsageBudget(undefined)).toEqual({ percent: null, windows: 'all' });
        expect(normalizeUsageBudget({ percent: 82.4, windows: 'session' })).toEqual({ percent: 82, windows: 'session' });
        expect(normalizeUsageBudget({ percent: 300, windows: 'x' })).toEqual({ percent: 100, windows: 'all' });
        expect(normalizeUsageBudget({ percent: 1 })).toEqual({ percent: 5, windows: 'all' });
    });
});

describe('usage threshold', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    const usage = (percent: number, resetsAt = '2026-11-20T14:30:00.000Z'): ProviderUsage[] => [
        { provider: 'claude', status: 'ok', windows: [{ kind: 'session', label: '5h', usedPercent: percent, resetsAt }] }
    ];

    it('finds the windows at or above the threshold', () => {
        expect(usageCrossings(usage(79), 80, now)).toEqual([]);
        expect(usageCrossings(usage(80), 80, now).map(item => item.slot)).toEqual(['claude:session:5h:2026-11-20T14']);
        expect(usageCrossings([{ ...usage(90)[0], status: 'error' }], 80, now)).toEqual([]);
        expect(usageCrossings([], 80, now)).toEqual([]);
    });

    it('gives one period the same slots when the reset time moves by a few seconds', () => {
        const window = { kind: 'session' as const, label: '5h', usedPercent: 90 };
        const before = usageSlots('codex', { ...window, resetsAt: '2026-11-20T14:59:58Z' }, now);
        const after = usageSlots('codex', { ...window, resetsAt: '2026-11-20T15:00:03Z' }, now);
        expect(before.slot).toBe('codex:session:5h:2026-11-20T14');
        expect(after.slot).toBe('codex:session:5h:2026-11-20T15');
        expect(after.nearby).toContain(before.slot);
        // The next period is 5 hours later. It shares no slot with this period.
        const next = usageSlots('codex', { ...window, resetsAt: '2026-11-20T19:59:58Z' }, now);
        expect([next.slot, ...next.nearby].some(slot => [before.slot, ...before.nearby].includes(slot))).toBe(false);
        expect(usageSlots('codex', window, now)).toEqual({ slot: 'codex:session:5h:day-2026-11-20', nearby: [] });
    });
});
