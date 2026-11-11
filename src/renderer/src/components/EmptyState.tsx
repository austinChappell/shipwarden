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

/** The content of an empty view: an icon, a title, one sentence and one action. All views use it, so they look the same. */
export function EmptyState({ icon: Icon, title, children, actions, hint, size = 'view' }: Props) {
    return (
        <div className={`empty-view${size === 'compact' ? ' compact' : ''}`}>
            <Icon size={size === 'compact' ? 22 : 30} strokeWidth={1.3} aria-hidden="true" />
            <h2>{title}</h2>
            <p>{children}</p>
            {actions && <div className="empty-view-actions">{actions}</div>}
            {hint && <p className="empty-view-hint">{hint}</p>}
        </div>
    );
}
