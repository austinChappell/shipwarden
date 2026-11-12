import { cx } from './cx';

interface CountProps {
    value: number;
    /**
     * "neutral" is for a count after a heading, a tab, or a filter. "accent" is only for a count that means "needs you",
     * for example the Dashboard and Review items of the sidebar. "on-primary" is for a count in a primary button.
     */
    tone?: 'neutral' | 'accent' | 'on-primary';
    /** The meaning of the count, for example "3 pull requests". It is the tooltip. */
    label?: string;
    className?: string;
}

/** A count badge: an 18 px pill. Use it for each count in the app. Do not write a count as text ("· 24"). */
export function Count({ value, tone = 'neutral', label, className }: CountProps) {
    return (
        <span className={cx('count', tone !== 'neutral' && tone, className)} title={label}>
            {value}
        </span>
    );
}
