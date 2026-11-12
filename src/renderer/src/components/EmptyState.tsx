import type { ComponentType, ReactNode } from 'react';

interface Props {
    /** A Lucide icon. */
    icon: ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean | 'true' }>;
    title: string;
    /** One sentence that tells why the view is empty. */
    children: ReactNode;
    /** The action that fixes it, usually one button. */
    actions?: ReactNode;
    /** A short note under the actions, for example a keyboard shortcut. */
    hint?: ReactNode;
    /** "compact" fits a panel or a card. The default fills a view. */
    size?: 'view' | 'compact';
}

/**
 * The content of an empty view (docs/design, board 4): an icon in a disc, a title, one sentence, and one action.
 * - A pane with nothing in it: give one primary button in `actions`.
 * - Nothing selected: give no `actions`.
 * All views use it, so they look the same. In a flex column, it fills the free space and centers its content.
 */
export function EmptyState({ icon: Icon, title, children, actions, hint, size = 'view' }: Props) {
    return (
        <div className={`empty-view${size === 'compact' ? ' compact' : ''}`}>
            <span className="empty-view-icon">
                <Icon size={size === 'compact' ? 16 : 18} strokeWidth={1.8} aria-hidden="true" />
            </span>
            <h2>{title}</h2>
            <p>{children}</p>
            {actions && <div className="empty-view-actions">{actions}</div>}
            {hint && <p className="empty-view-hint">{hint}</p>}
        </div>
    );
}
