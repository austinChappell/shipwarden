import type { ReactNode } from 'react';

interface GroupProps {
    title: string;
    description?: ReactNode;
    /** Puts the content in a card. Use it for rows. Leave it off for content with its own cards, for example the theme grid. */
    card?: boolean;
    /** Controls at the right of the title, for example an "Add" button. */
    actions?: ReactNode;
    children: ReactNode;
}

/** A titled group of settings. The title and the description are outside the card, so each group is easy to find. */
export function SettingsGroup({ title, description, card = false, actions, children }: GroupProps) {
    return (
        <section className="settings-group">
            <div className="settings-group-header">
                <div>
                    <h3>{title}</h3>
                    {description && <p className="settings-group-description">{description}</p>}
                </div>
                {actions && <div className="settings-group-actions">{actions}</div>}
            </div>
            {card ? <div className="settings-card">{children}</div> : children}
        </section>
    );
}

interface RowProps {
    label: ReactNode;
    description?: ReactNode;
    /** The control at the right, for example a segmented control or a switch. */
    control?: ReactNode;
    /** Content under the label, at the full width of the row, for example a text field. */
    children?: ReactNode;
}

/** One row in a settings card: the label and the description at the left, the control at the right. */
export function SettingsRow({ label, description, control, children }: RowProps) {
    return (
        <div className="settings-row">
            <div className="settings-row-main">
                <div className="settings-row-text">
                    <div className="settings-row-label">{label}</div>
                    {description && <div className="settings-row-description">{description}</div>}
                </div>
                {control && <div className="settings-row-control">{control}</div>}
            </div>
            {children && <div className="settings-row-body">{children}</div>}
        </div>
    );
}
