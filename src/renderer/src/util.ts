/** Returns the message of an error. IPC errors start with a prefix that the user does not need to see. */
export function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** Formats the time between two ISO dates, for example "1m 12s". */
export function formatDuration(start: string | null, end: string | null): string {
    if (!start) {
        return '';
    }
    const seconds = Math.max(0, Math.round(((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ${seconds % 60}s`;
    }
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Formats an ISO date as a relative time, for example "3h ago". */
export function timeAgo(iso: string): string {
    const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}
