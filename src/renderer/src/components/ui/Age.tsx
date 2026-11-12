import { ageTone, formatAge, formatAgo } from '@shared/format';
import { cx } from './cx';

interface AgeProps {
    /** The ISO date. */
    date: string;
    /** "column" shows "7h" in the color of the age. "prose" shows "7h ago" with no color. */
    format?: 'column' | 'prose';
    /** Keeps the muted color for all ages, for an age that is not a warning, for example the time of a commit. */
    plain?: boolean;
    /** The tooltip. The default is the full date. */
    title?: string;
    className?: string;
}

/** An age in the format and the color of docs/design (board 4). The full date is the tooltip. */
export function Age({ date, format = 'column', plain, title, className }: AgeProps) {
    const tone = format === 'column' && !plain ? ageTone(date) : 'muted';
    return (
        <time className={cx('age', tone !== 'muted' && tone, className)} dateTime={date} title={title ?? new Date(date).toLocaleString()}>
            {format === 'column' ? formatAge(date) : formatAgo(date)}
        </time>
    );
}
