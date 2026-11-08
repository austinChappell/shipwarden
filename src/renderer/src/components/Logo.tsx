import { useId } from 'react';

/**
 * The ShipWarden mark: a shield with the helm of a ship, and a port light (red) and a starboard light (green) on its
 * top corners. It is the app icon in a small size. The colors come from the theme, so the mark fits each theme.
 */
export function Logo({ size = 24, title = 'ShipWarden' }: { size?: number; title?: string }) {
    // Two logos on one page must not share gradient IDs.
    const id = useId().replace(/:/g, '');
    return (
        <svg className="logo" width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={title}>
            <defs>
                <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" style={{ stopColor: 'var(--raised)' }} />
                    <stop offset="1" style={{ stopColor: 'var(--bg)' }} />
                </linearGradient>
                <linearGradient id={`${id}-shield`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" style={{ stopColor: 'var(--accent)', stopOpacity: 0.2 }} />
                    <stop offset="1" style={{ stopColor: 'var(--accent)', stopOpacity: 0.03 }} />
                </linearGradient>
            </defs>
            <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="8" fill={`url(#${id}-tile)`} style={{ stroke: 'var(--border)' }} strokeWidth="1.5" />
            {/* The shield of the warden. */}
            <path
                d="M16 4.4 L26.3 7.6 V16.1 C26.3 23 21.7 27.2 16 29.6 C10.3 27.2 5.7 23 5.7 16.1 V7.6 Z"
                fill={`url(#${id}-shield)`}
                style={{ stroke: 'var(--accent)' }}
                strokeWidth="1.5"
                strokeLinejoin="round"
            />
            {/* The helm of the ship: spokes, a rim, handles and a hub. */}
            <g style={{ stroke: 'var(--accent)' }} strokeWidth="1" strokeLinecap="round">
                <line x1="16" y1="17" x2="23.40" y2="17.00" />
                <line x1="16" y1="17" x2="21.23" y2="22.23" />
                <line x1="16" y1="17" x2="16.00" y2="24.40" />
                <line x1="16" y1="17" x2="10.77" y2="22.23" />
                <line x1="16" y1="17" x2="8.60" y2="17.00" />
                <line x1="16" y1="17" x2="10.77" y2="11.77" />
                <line x1="16" y1="17" x2="16.00" y2="9.60" />
                <line x1="16" y1="17" x2="21.23" y2="11.77" />
            </g>
            <circle cx="16" cy="17" r="5.3" fill="none" style={{ stroke: 'var(--accent)' }} strokeWidth="1.3" />
            <g style={{ fill: 'var(--accent)' }}>
                <circle cx="23.90" cy="17.00" r="1" />
                <circle cx="21.59" cy="22.59" r="1" />
                <circle cx="16.00" cy="24.90" r="1" />
                <circle cx="10.41" cy="22.59" r="1" />
                <circle cx="8.10" cy="17.00" r="1" />
                <circle cx="10.41" cy="11.41" r="1" />
                <circle cx="16.00" cy="9.10" r="1" />
                <circle cx="21.59" cy="11.41" r="1" />
            </g>
            <circle cx="16" cy="17" r="1.7" style={{ fill: 'var(--bg)', stroke: 'var(--accent)' }} strokeWidth="1" />
            {/* The port light (red) and the starboard light (green). */}
            <circle cx="5.7" cy="7.6" r="1.9" style={{ fill: 'var(--danger)', stroke: 'var(--bg)' }} strokeWidth="0.8" />
            <circle cx="26.3" cy="7.6" r="1.9" style={{ fill: 'var(--ok)', stroke: 'var(--bg)' }} strokeWidth="0.8" />
        </svg>
    );
}
