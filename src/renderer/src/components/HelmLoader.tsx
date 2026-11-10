import { useEffect, useId, useState } from 'react';

/** The texts that the loader shows in turn. */
const PHRASES = [
    'Hoisting the sails',
    'Reading the charts',
    'Checking the wind',
    'Swabbing the deck',
    'Sounding the depth',
    'Trimming the sails',
    'Watching the horizon'
];

/** The time in milliseconds that the loader shows one text. */
const PHRASE_MS = 2400;

/** The text below a loader. Without a label, the text changes every few seconds. */
function LoaderCaption({ label, hint }: { label?: string; hint?: string }) {
    const [index, setIndex] = useState(() => Math.floor(Math.random() * PHRASES.length));

    useEffect(() => {
        if (label) return;
        const timer = window.setInterval(() => setIndex(value => (value + 1) % PHRASES.length), PHRASE_MS);
        return () => window.clearInterval(timer);
    }, [label]);

    const text = label ?? PHRASES[index];

    return (
        <>
            <div className="sea-loader-text">
                <span key={text} className="sea-loader-label">{text}</span>
                <span className="sea-loader-dots" aria-hidden="true"><i /><i /><i /></span>
            </div>
            {hint && <div className="sea-loader-hint">{hint}</div>}
        </>
    );
}

/** The angles of the 8 spokes, in degrees. */
const SPOKES = [0, 45, 90, 135, 180, 225, 270, 315];

/**
 * A loading state: the helm of a ship that turns fast in one direction, slows to a stop and then turns in the other
 * direction. The colors come from the theme. The animation stops when the system asks for reduced motion.
 */
export function HelmLoader({ label, hint }: { label?: string; hint?: string }) {
    // Two loaders on one page must not share gradient IDs.
    const id = useId().replace(/:/g, '');
    const wood = `url(#${id}-wood)`;
    return (
        <div className="sea-loader helm-loader" role="status" aria-live="polite">
            <svg className="helm-loader-art" viewBox="0 0 100 100" aria-hidden="true">
                <defs>
                    {/* User space units: a gradient in box units does not paint a straight line, because its box has no width. */}
                    <radialGradient id={`${id}-wood`} gradientUnits="userSpaceOnUse" cx="50" cy="40" r="55">
                        <stop offset="0" style={{ stopColor: 'color-mix(in srgb, var(--accent) 75%, white)' }} />
                        <stop offset="1" style={{ stopColor: 'color-mix(in srgb, var(--accent) 80%, black)' }} />
                    </radialGradient>
                    <linearGradient id={`${id}-hub`} x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" style={{ stopColor: 'var(--accent)' }} />
                        <stop offset="1" style={{ stopColor: 'var(--claude)' }} />
                    </linearGradient>
                </defs>
                <g className="helm-spin">
                    {/* The spokes. Each spoke ends in a handle outside the rim. */}
                    <g stroke={wood} strokeLinecap="round">
                        {SPOKES.map(angle => (
                            <g key={angle} transform={`rotate(${angle} 50 50)`}>
                                <line x1="50" y1="50" x2="50" y2="8" strokeWidth="4" />
                                <line x1="50" y1="15" x2="50" y2="5" strokeWidth="7.5" />
                            </g>
                        ))}
                    </g>
                    {/* The rim, with a dashed inner line for depth. */}
                    <circle cx="50" cy="50" r="31" fill="none" stroke={wood} strokeWidth="7" />
                    <circle cx="50" cy="50" r="31" fill="none" style={{ stroke: 'var(--bg)' }} strokeOpacity="0.35" strokeWidth="1" strokeDasharray="3 5" />
                    {/* The hub. */}
                    <circle cx="50" cy="50" r="10" fill={`url(#${id}-hub)`} />
                    <circle cx="50" cy="50" r="4" style={{ fill: 'var(--bg)' }} fillOpacity="0.55" />
                    {/* A red mark on the top handle makes the turns easy to see. */}
                    <circle cx="50" cy="6.5" r="2.2" style={{ fill: 'var(--danger)' }} />
                </g>
            </svg>
            <LoaderCaption label={label} hint={hint} />
        </div>
    );
}
