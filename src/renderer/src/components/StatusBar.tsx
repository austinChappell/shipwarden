import { useEffect, useState } from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { formatResetIn, highestWindow, PROVIDER_NAMES, type ProviderUsage, type UsageWindow } from '@shared/usage';
import { useRefreshUsage, useUsage } from '../usage-query';

/** The color class of a usage value: green, then amber from 70 %, then red from 90 %. */
function level(percent: number): string {
    return percent >= 90 ? 'high' : percent >= 70 ? 'medium' : 'low';
}

function windowName(window: UsageWindow): string {
    return window.kind === 'session' ? `${window.label} limit` : window.kind === 'weekly' ? 'Weekly limit' : `Weekly ${window.label} limit`;
}

/** A line for the tooltip, for example "5h limit: 7% used, resets in 4h 6m (Sat 6:49 AM)". */
function windowLine(window: UsageWindow, now: number): string {
    const resetIn = formatResetIn(window.resetsAt, now);
    const at = window.resetsAt ? new Date(window.resetsAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : undefined;
    return `${windowName(window)}: ${window.usedPercent}% used${resetIn ? `, resets in ${resetIn} (${at})` : ''}`;
}

/** The short text of one window in the detailed view: "7% 4h 6m", or "0% Fable" for a model limit. */
function windowText(window: UsageWindow, now: number): string {
    if (window.kind === 'model') {
        return `${window.usedPercent}% ${window.label}`;
    }
    const resetIn = formatResetIn(window.resetsAt, now);
    return resetIn ? `${window.usedPercent}% ${resetIn}` : `${window.usedPercent}%`;
}

function ProviderView({ usage, now }: { usage: ProviderUsage; now: number }) {
    const name = PROVIDER_NAMES[usage.provider];
    const top = highestWindow(usage.windows);
    const updated = usage.updatedAt ? `Updated ${new Date(usage.updatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.` : '';
    const title = [`${name}${usage.plan ? ` (${usage.plan})` : ''}`, ...usage.windows.map(window => windowLine(window, now)), usage.error ?? '', updated]
        .filter(Boolean)
        .join('\n');

    return (
        <span className={`usage-provider${usage.status === 'error' ? ' stale' : ''}`} title={title}>
            <span className={`usage-name ${usage.provider}`}>{name}</span>
            {usage.status === 'error' && <CircleAlert className="usage-warning" size={12} strokeWidth={2} />}
            {top ? (
                <>
                    <span className={`usage-compact usage-value ${level(top.usedPercent)}`}>{top.usedPercent}%</span>
                    <span className="usage-detail">
                        <span className="usage-meter" aria-hidden>
                            <span className={`usage-meter-fill ${level(top.usedPercent)}`} style={{ width: `${Math.max(top.usedPercent, 2)}%` }} />
                        </span>
                        {usage.windows.map((window, index) => (
                            <span key={`${window.kind}:${window.label}`}>
                                {index > 0 && <span className="usage-separator">·</span>}
                                <span className={`usage-value ${level(window.usedPercent)}`}>{windowText(window, now)}</span>
                            </span>
                        ))}
                    </span>
                </>
            ) : (
                <span className="usage-value">—</span>
            )}
        </span>
    );
}

/**
 * The status bar at the bottom of the window. It shows the plan usage of the agents, as `/usage` shows it in Claude Code
 * and Codex. A narrow window shows the highest value of each agent. A wide window shows each limit with its reset time.
 */
export function StatusBar() {
    const usage = useUsage();
    const [now, setNow] = useState(Date.now());
    const refreshUsage = useRefreshUsage();
    const refreshing = refreshUsage.isPending;

    // The reset times count down, so the text changes each minute.
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(timer);
    }, []);

    const shown = usage.filter(item => item.status !== 'signed-out');

    // A failed refresh keeps the old usage. Each provider shows its own error.
    const refresh = () => refreshUsage.mutate(undefined, { onSuccess: () => setNow(Date.now()) });

    return (
        <footer className="status-bar">
            <span className="usage-label">Used</span>
            {shown.length === 0 && (
                <span className="usage-value muted" title="ShipWarden found no Claude Code or Codex sign-in on this Mac.">
                    No agent sign-in
                </span>
            )}
            {shown.map(item => (
                <ProviderView key={item.provider} usage={item} now={now} />
            ))}
            <span className="status-bar-spacer" />
            <button className="icon-button status-bar-refresh" title="Refresh usage" disabled={refreshing} onClick={refresh}>
                <RefreshCw size={13} strokeWidth={1.75} className={refreshing ? 'spin' : undefined} />
            </button>
        </footer>
    );
}
