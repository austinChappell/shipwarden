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

/**
 * Make a wave path that is 2 periods wider than the view box. The CSS moves the path by one period in a loop, so the
 * loop has no visible seam.
 */
function wavePath(baseY: number, amplitude: number, period: number, width: number, height: number): string {
    const half = period / 2;
    let d = `M0 ${baseY} Q${half / 2} ${baseY - amplitude} ${half} ${baseY}`;
    for (let x = period; x <= width + period * 2; x += half) d += ` T${x} ${baseY}`;
    return `${d} V${height} H0 Z`;
}

const BACK_WAVE = wavePath(52, 3, 40, 160, 80);
const FRONT_WAVE = wavePath(58, 4, 56, 160, 80);

/**
 * A loading state: a small boat that rocks on moving waves, with a text that changes. The colors come from the theme.
 * The animation stops when the system asks for reduced motion.
 */
export function SeaLoader({ label, hint, compact = false }: { label?: string; hint?: string; compact?: boolean }) {
    const id = useId().replace(/:/g, '');
    const [index, setIndex] = useState(() => Math.floor(Math.random() * PHRASES.length));

    useEffect(() => {
        if (label) return;
        const timer = window.setInterval(() => setIndex(value => (value + 1) % PHRASES.length), PHRASE_MS);
        return () => window.clearInterval(timer);
    }, [label]);

    const text = label ?? PHRASES[index];

    return (
        <div className={`sea-loader${compact ? ' compact' : ''}`} role="status" aria-live="polite">
            <svg className="sea-loader-art" viewBox="0 0 160 80" aria-hidden="true">
                <defs>
                    <clipPath id={`${id}-frame`}>
                        <rect x="0" y="0" width="160" height="80" rx="14" />
                    </clipPath>
                    <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" style={{ stopColor: 'var(--info)', stopOpacity: 0.02 }} />
                        <stop offset="1" style={{ stopColor: 'var(--info)', stopOpacity: 0.12 }} />
                    </linearGradient>
                    <linearGradient id={`${id}-sail`} x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" style={{ stopColor: 'var(--accent)' }} />
                        <stop offset="1" style={{ stopColor: 'var(--claude)' }} />
                    </linearGradient>
                </defs>
                <g clipPath={`url(#${id}-frame)`}>
                    <rect width="160" height="80" fill={`url(#${id}-sky)`} />

                    {/* The sun, with a ring that pulses. */}
                    <circle className="sea-sun-ring" cx="128" cy="20" r="11" style={{ fill: 'var(--accent)' }} />
                    <circle cx="128" cy="20" r="7" style={{ fill: 'var(--accent)' }} />

                    {/* Two gulls that move across the sky. */}
                    <g className="sea-gulls" style={{ stroke: 'var(--muted)' }} strokeWidth="1.3" fill="none" strokeLinecap="round">
                        <path d="M30 18 q3 -3 6 0 q3 -3 6 0" />
                        <path d="M46 12 q2 -2 4 0 q2 -2 4 0" />
                    </g>

                    <path className="sea-wave back" d={BACK_WAVE} style={{ fill: 'var(--info)' }} />

                    {/* The boat. The outer group bobs. The inner group rocks. */}
                    <g className="sea-boat-bob">
                        <g className="sea-boat-rock">
                            <line x1="80" y1="22" x2="80" y2="50" style={{ stroke: 'var(--text-strong)' }} strokeWidth="1.6" strokeLinecap="round" />
                            <path className="sea-flag" d="M80 22 L88 24.5 L80 27 Z" style={{ fill: 'var(--danger)' }} />
                            <path d="M82 28 Q96 38 98 48 L82 48 Z" fill={`url(#${id}-sail)`} />
                            <path d="M78 31 Q68 40 67 48 L78 48 Z" style={{ fill: 'var(--text-strong)' }} opacity="0.85" />
                            <path
                                d="M62 50 H102 L96 59 Q80 62 68 59 Z"
                                style={{ fill: 'var(--raised)', stroke: 'var(--text-strong)' }}
                                strokeWidth="1.4"
                                strokeLinejoin="round"
                            />
                            <circle cx="74" cy="54.5" r="1.4" style={{ fill: 'var(--accent)' }} />
                            <circle cx="81" cy="54.5" r="1.4" style={{ fill: 'var(--accent)' }} />
                            <circle cx="88" cy="54.5" r="1.4" style={{ fill: 'var(--accent)' }} />
                        </g>
                    </g>

                    <path className="sea-wave front" d={FRONT_WAVE} style={{ fill: 'var(--info)' }} />

                    {/* Small bubbles that rise from the front wave. */}
                    <g style={{ fill: 'var(--text-strong)' }}>
                        <circle className="sea-bubble b1" cx="40" cy="72" r="1.2" />
                        <circle className="sea-bubble b2" cx="118" cy="74" r="1" />
                        <circle className="sea-bubble b3" cx="140" cy="70" r="1.4" />
                    </g>
                </g>
            </svg>
            <div className="sea-loader-text">
                <span key={text} className="sea-loader-label">{text}</span>
                <span className="sea-loader-dots" aria-hidden="true"><i /><i /><i /></span>
            </div>
            {hint && <div className="sea-loader-hint">{hint}</div>}
        </div>
    );
}
