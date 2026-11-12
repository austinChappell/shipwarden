import type { ReactNode } from 'react';
import { cx } from './cx';

/**
 * The tone of a chip. Each status tone has one meaning (docs/design, board 2):
 * - "neutral": no status, for example a repository reference or a count of comments.
 * - "info": blue information, for example "Default" or a port.
 * - "pending": work in progress, for example an agent that works or a check that runs.
 * - "success": ready or passing.
 * - "warning": a conflict, or a missing ticket.
 * - "danger": failing or blocked.
 * - "review": changes requested, or a merged pull request.
 * - "label": a task label. It uses the muted label palette, never a status color. Set `labelIndex` for the color.
 */
export type ChipTone = 'neutral' | 'info' | 'pending' | 'success' | 'warning' | 'danger' | 'review' | 'label';

/** The number of colors in the label palette. */
export const LABEL_COLORS = 5;

/** Returns the index in the label palette for a label name. The same name always gets the same color. */
export function labelIndex(name: string): number {
    let hash = 0;
    for (const char of name.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return hash % LABEL_COLORS;
}

interface ChipProps {
    tone?: ChipTone;
    /** The monospace font. Use it only for identifiers: a repository number, a port, a branch, or a file name. */
    mono?: boolean;
    /** A 12 px icon before the text. */
    icon?: ReactNode;
    /** The color of a "label" chip, from 0 to 4. The default comes from the text of the chip, when it is a string. */
    labelIndex?: number;
    title?: string;
    className?: string;
    children: ReactNode;
}

/** A chip: 20 px high, a soft fill in its tone, and no border. Use it for each status tag and each label. */
export function Chip({ tone = 'neutral', mono, icon, labelIndex: index, title, className, children }: ChipProps) {
    const color = tone === 'label' ? (index ?? (typeof children === 'string' ? labelIndex(children) : 0)) : undefined;
    return (
        <span className={cx('chip', `tone-${tone}`, color !== undefined && `label-${color + 1}`, mono && 'mono', className)} title={title}>
            {icon}
            {children}
        </span>
    );
}
