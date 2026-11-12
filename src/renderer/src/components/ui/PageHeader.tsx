import type { ComponentType, ReactNode } from 'react';
import { cx } from './cx';

interface PageHeaderProps {
    /** A Lucide icon. It is the same icon as the item of the page in the sidebar. */
    icon?: ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean | 'true' }>;
    title: ReactNode;
    /** One short status line after the title: a count ("2 notes") or the time of the last update ("Updated 1m ago"). */
    meta?: ReactNode;
    /** The controls that select what the page shows, for example a repository picker or a segmented control. */
    scope?: ReactNode;
    /** The filter field of the page (FilterField). */
    filter?: ReactNode;
    /** Secondary buttons and icon buttons. Put the refresh button last. */
    actions?: ReactNode;
    /** Zero or one primary button: the main create or start action of the page. */
    primary?: ReactNode;
    /** Content before the icon, for example the button that shows the sidebar. */
    leading?: ReactNode;
    className?: string;
}

/**
 * The header of a page (docs/design, board 3). It is 52 px high and has the same zones in the same order on each page:
 * icon, title and meta, then scope, then a space, then the filter, the actions, and the primary button.
 * A zone can be empty. A zone never moves. Settings is the only page with a different header.
 */
export function PageHeader({ icon: Icon, title, meta, scope, filter, actions, primary, leading, className }: PageHeaderProps) {
    return (
        <header className={cx('page-header', className)}>
            {leading}
            <div className="page-header-title">
                {Icon && <Icon size={16} strokeWidth={1.8} aria-hidden="true" />}
                <h1>{title}</h1>
                {meta && <span className="page-header-meta">{meta}</span>}
            </div>
            {scope && <div className="page-header-scope">{scope}</div>}
            <div className="page-header-space" />
            {filter}
            {actions && <div className="page-header-actions">{actions}</div>}
            {primary}
        </header>
    );
}
