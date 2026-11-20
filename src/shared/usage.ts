import { agentProgramOf } from './agent-programs';

/** One usage limit of an agent plan, for example the 5-hour limit of Claude. */
export interface UsageWindow {
    /** "session" is the short limit (for example 5 hours). "weekly" is the 7-day limit. "model" is a weekly limit of one model. */
    kind: 'session' | 'weekly' | 'model';
    /** A short name for the UI, for example "5h", "Weekly" or "Fable". */
    label: string;
    /** 0 to 100. */
    usedPercent: number;
    /** When the limit resets, as an ISO time. */
    resetsAt?: string;
}

export type UsageProvider = 'claude' | 'codex';

export interface ProviderUsage {
    provider: UsageProvider;
    /**
     * - ok: the windows are current.
     * - signed-out: ShipWarden found no sign-in for this agent. The status bar does not show it.
     * - error: the last request failed. `windows` keeps the last good values, if any.
     */
    status: 'ok' | 'signed-out' | 'error';
    windows: UsageWindow[];
    plan?: string;
    error?: string;
    /** The time of the last good request, in milliseconds. */
    updatedAt?: number;
}

export const PROVIDER_NAMES: Record<UsageProvider, string> = { claude: 'Claude', codex: 'Codex' };

function finite(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function percent(value: number): number {
    return Math.min(100, Math.max(0, Math.round(value)));
}

/** Converts a reset time to ISO. Accepts an ISO string, epoch seconds or epoch milliseconds. */
export function resetTime(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim()) {
        const time = Date.parse(value);
        return Number.isNaN(time) ? undefined : new Date(time).toISOString();
    }
    const number = finite(value);
    if (number === undefined || number <= 0) {
        return undefined;
    }
    // A value below 10^12 is in seconds. Milliseconds since 1970 passed 10^12 in 2001.
    return new Date(number < 1e12 ? number * 1000 : number).toISOString();
}

function claudeWindow(value: unknown, kind: UsageWindow['kind'], label: string): UsageWindow | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const raw = value as Record<string, unknown>;
    const used = finite(raw.utilization) ?? finite(raw.used_percentage) ?? finite(raw.percent);
    return used === undefined ? undefined : { kind, label, usedPercent: percent(used), resetsAt: resetTime(raw.resets_at) };
}

function titleCase(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Reads the response of Claude's usage endpoint (`/api/oauth/usage`).
 * It has `five_hour` and `seven_day`, and weekly limits of single models, either in `limits`
 * (kind "weekly_scoped") or as `seven_day_<model>`.
 */
export function parseClaudeUsage(body: unknown): UsageWindow[] {
    if (!body || typeof body !== 'object') {
        return [];
    }
    const raw = body as Record<string, unknown>;
    const windows: UsageWindow[] = [];
    const session = claudeWindow(raw.five_hour, 'session', '5h');
    const weekly = claudeWindow(raw.seven_day, 'weekly', 'Weekly');
    if (session) windows.push(session);
    if (weekly) windows.push(weekly);

    const models = new Map<string, UsageWindow>();
    if (Array.isArray(raw.limits)) {
        for (const limit of raw.limits) {
            const item = limit as Record<string, unknown> | null;
            const scope = item?.scope as { model?: { display_name?: unknown } } | undefined;
            const name = typeof scope?.model?.display_name === 'string' ? scope.model.display_name.trim() : '';
            const window = item?.kind === 'weekly_scoped' && name ? claudeWindow(item, 'model', name) : undefined;
            if (window && !models.has(name.toLowerCase())) {
                models.set(name.toLowerCase(), window);
            }
        }
    }
    for (const [key, value] of Object.entries(raw)) {
        const match = /^seven_day_([a-z]+)$/.exec(key);
        // "seven_day_oauth_apps" and similar are not model limits. Only a single word is a model name.
        if (!match || models.has(match[1])) {
            continue;
        }
        const window = claudeWindow(value, 'model', titleCase(match[1]));
        if (window) {
            models.set(match[1], window);
        }
    }
    return [...windows, ...models.values()];
}

function codexWindow(value: unknown): UsageWindow | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const raw = value as Record<string, unknown>;
    const used = finite(raw.used_percent);
    if (used === undefined) {
        return undefined;
    }
    const seconds = finite(raw.limit_window_seconds);
    // A window of one day or less is the session limit. Codex uses 5 hours.
    const session = seconds === undefined || seconds <= 24 * 3600;
    const resetsAt =
        resetTime(raw.reset_at) ??
        (finite(raw.reset_after_seconds) !== undefined ? new Date(Date.now() + finite(raw.reset_after_seconds)! * 1000).toISOString() : undefined);
    return {
        kind: session ? 'session' : 'weekly',
        label: session ? (seconds ? `${Math.round(seconds / 3600)}h` : 'Session') : 'Weekly',
        usedPercent: percent(used),
        resetsAt
    };
}

/** Reads the response of the ChatGPT usage endpoint (`/backend-api/wham/usage`) that Codex uses. */
export function parseCodexUsage(body: unknown): { windows: UsageWindow[]; plan?: string } {
    if (!body || typeof body !== 'object') {
        return { windows: [] };
    }
    const raw = body as Record<string, unknown>;
    const limits = (raw.rate_limit ?? {}) as Record<string, unknown>;
    const windows = [codexWindow(limits.primary_window), codexWindow(limits.secondary_window)].filter((item): item is UsageWindow => !!item);
    // Show the session limit first, then the weekly limit, as for Claude.
    windows.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'session' ? -1 : 1));
    return { windows, plan: typeof raw.plan_type === 'string' ? raw.plan_type : undefined };
}

/** The window that is nearest to its limit. The compact status bar shows it. */
export function highestWindow(windows: readonly UsageWindow[]): UsageWindow | undefined {
    return windows.reduce<UsageWindow | undefined>((max, window) => (!max || window.usedPercent > max.usedPercent ? window : max), undefined);
}

/** Returns the time until a reset, for example "4h 6m", "1d 3h" or "12m". */
export function formatResetIn(resetsAt: string | undefined, now: number): string | undefined {
    if (!resetsAt) {
        return undefined;
    }
    const minutes = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60_000));
    if (Number.isNaN(minutes)) {
        return undefined;
    }
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours}h ${minutes % 60}m`;
    }
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Usage budget                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The windows that a budget checks. "session" checks only the short limit (for example 5 hours). "all" checks each limit. */
export type BudgetWindows = 'session' | 'all';

/**
 * The usage budget of Settings › Agents. ShipWarden does not start new agents from the queue, plans, Compare agents, and
 * the `startAgent` automation action while the plan usage is at or above the percent. Agents that work now continue.
 */
export interface UsageBudget {
    /** 5 to 100. Null: no budget. */
    percent: number | null;
    windows: BudgetWindows;
}

export const BUDGET_MIN = 5;
export const BUDGET_MAX = 100;
export const BUDGET_STEP = 5;
/** The value of the field when the user turns the budget on. */
export const BUDGET_FALLBACK = 80;

export const DEFAULT_USAGE_BUDGET: UsageBudget = { percent: null, windows: 'all' };

/** Converts a stored value to a valid budget. A value with a wrong type gets its default. */
export function normalizeUsageBudget(value: unknown): UsageBudget {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const number = finite(raw.percent);
    return {
        percent: number === undefined ? null : Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, Math.round(number))),
        windows: raw.windows === 'session' ? 'session' : 'all'
    };
}

/** The usage provider of an agent command: "claude" for Claude Code, "codex" for Codex. Other agents have no usage data. */
export function usageProviderOf(program: string | undefined): UsageProvider | undefined {
    return program === 'claude' || program === 'codex' ? program : undefined;
}

/** Why a budget stops a start: the provider, the window at or above the budget, and the budget. */
export interface BudgetBlock {
    provider: UsageProvider;
    window: UsageWindow;
    percent: number;
}

/**
 * Returns why the budget stops a new agent of the provider now, or undefined when the agent can start.
 * The agent can start in these cases:
 * - The budget is off, or the agent has no usage provider (for example Gemini CLI).
 * - The usage of the provider did not load correctly. No data means no block.
 * - Each checked window is below the budget, or its reset time passed (the data is old).
 * When more than one window is at or above the budget, the window that resets last counts. The agent must wait for it.
 */
export function budgetBlock(usage: readonly ProviderUsage[], budget: UsageBudget, provider: UsageProvider | undefined, now: number): BudgetBlock | undefined {
    if (budget.percent === null || !provider) return undefined;
    const data = usage.find(item => item.provider === provider);
    if (data?.status !== 'ok') return undefined;
    const percent = budget.percent;
    const over = data.windows.filter(window => {
        if (budget.windows === 'session' && window.kind !== 'session') return false;
        if (window.resetsAt && Date.parse(window.resetsAt) <= now) return false;
        return window.usedPercent >= percent;
    });
    if (over.length === 0) return undefined;
    const resetOf = (window: UsageWindow) => (window.resetsAt ? Date.parse(window.resetsAt) : Number.POSITIVE_INFINITY);
    const window = over.reduce((last, item) => (resetOf(item) > resetOf(last) ? item : last));
    return { provider, window, percent };
}

/** The first words of each wait text of a budget. The UI and the tests look for them. */
export const BUDGET_WAIT = 'Waiting for usage to reset';

/** Returns the local clock time of a reset, for example "2:30 PM", or "Fri 2:30 PM" when it is more than 20 hours away. */
export function formatResetAt(resetsAt: string, now: number): string {
    const time = Date.parse(resetsAt);
    const far = time - now > 20 * 3600_000;
    return new Date(time).toLocaleString([], { ...(far ? { weekday: 'short' } : {}), hour: 'numeric', minute: '2-digit' });
}

/**
 * The text of a start that waits for the budget, for example
 * "Waiting for usage to reset. Claude (5h) is at 85%, and the budget is 80%. It resets at 2:30 PM (in 1h 10m)."
 * Without `now`, the text has the clock time only. A saved text uses this form, so it does not change each minute.
 */
export function budgetWaitText(block: BudgetBlock, now?: number): string {
    const { provider, window, percent } = block;
    const head = `${BUDGET_WAIT}. ${PROVIDER_NAMES[provider]} (${window.label}) is at ${window.usedPercent}%, and the budget is ${percent}%.`;
    if (!window.resetsAt) return `${head} The reset time is not known.`;
    const clock = formatResetAt(window.resetsAt, now ?? Date.now());
    const relative = now === undefined ? undefined : formatResetIn(window.resetsAt, now);
    return `${head} It resets at ${clock}${relative ? ` (in ${relative})` : ''}.`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Usage threshold                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A window that is at or above a threshold. The `slot` names one reset period of the window. */
export interface UsageCrossing {
    provider: UsageProvider;
    window: UsageWindow;
    /**
     * The provider, the window, and the hour of the reset, for example "claude:session:5h:2026-11-20T14".
     * A new period of the window has a new reset time, so it gets a new slot. Without a reset time, the slot uses the day.
     */
    slot: string;
    /**
     * The slots of the hours before and after the reset. A reset time can move by a few seconds between two requests,
     * and then go into the next hour. A slot in this list that fired means that this period fired. Two periods of a
     * window are at least 5 hours apart, so they never share a slot of this list.
     */
    nearby: string[];
}

function hourSlot(time: number): string {
    return new Date(Math.floor(time / 3600_000) * 3600_000).toISOString().slice(0, 13);
}

/** Returns the slot of a window and the slots of the hours next to it (see `UsageCrossing`). */
export function usageSlots(provider: UsageProvider, window: UsageWindow, now: number): { slot: string; nearby: string[] } {
    const base = `${provider}:${window.kind}:${window.label}`;
    const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    if (Number.isNaN(reset)) return { slot: `${base}:day-${new Date(now).toISOString().slice(0, 10)}`, nearby: [] };
    return { slot: `${base}:${hourSlot(reset)}`, nearby: [`${base}:${hourSlot(reset - 3600_000)}`, `${base}:${hourSlot(reset + 3600_000)}`] };
}

/**
 * Returns the windows that are at or above the threshold now. Only usage that loaded correctly counts, and a window
 * whose reset time passed does not count. The caller fires one time for each slot. A slot that fired (or a nearby
 * slot) does not fire again, so a poll with the same value does nothing.
 */
export function usageCrossings(usage: readonly ProviderUsage[], threshold: number, now: number): UsageCrossing[] {
    const crossings: UsageCrossing[] = [];
    for (const provider of usage) {
        if (provider.status !== 'ok') continue;
        for (const window of provider.windows) {
            if (window.usedPercent < threshold) continue;
            if (window.resetsAt && Date.parse(window.resetsAt) <= now) continue;
            crossings.push({ provider: provider.provider, window, ...usageSlots(provider.provider, window, now) });
        }
    }
    return crossings;
}

/**
 * Returns why the budget stops a start of these agent commands now, or undefined. Each command counts, for example
 * the agents of Compare agents. The first command that the budget stops gives the result.
 */
export function agentBudgetBlock(usage: readonly ProviderUsage[], budget: UsageBudget, commands: readonly string[], now: number): BudgetBlock | undefined {
    for (const command of commands) {
        const block = budgetBlock(usage, budget, usageProviderOf(agentProgramOf(command)), now);
        if (block) return block;
    }
    return undefined;
}
