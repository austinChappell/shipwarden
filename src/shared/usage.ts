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
    const resetsAt = resetTime(raw.reset_at) ?? (finite(raw.reset_after_seconds) !== undefined ? new Date(Date.now() + finite(raw.reset_after_seconds)! * 1000).toISOString() : undefined);
    return { kind: session ? 'session' : 'weekly', label: session ? (seconds ? `${Math.round(seconds / 3600)}h` : 'Session') : 'Weekly', usedPercent: percent(used), resetsAt };
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
