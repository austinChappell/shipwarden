import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export interface CardProps extends HTMLAttributes<HTMLElement> {
    /** The element of the card. Use "section" when the card has a header with a title. */
    as?: 'div' | 'section' | 'article' | 'li';
    /** The color of the border, for example "ok" for an approved review. */
    tone?: 'default' | 'ok' | 'danger' | 'accent' | 'info' | 'merge';
    /** Shows the border as a dashed line, for example for a draft or for content that is not active. */
    dashed?: boolean;
}

/**
 * A box with a border and rounded corners. The card does not clip its content, so a menu or a popover in it can
 * show outside the card. Put a `CardHeader`, one or more `CardBody` parts, and a `CardFooter` in it.
 * The parts have lines between them.
 */
export function Card({ as: Tag = 'div', tone = 'default', dashed = false, className, children, ...rest }: CardProps) {
    return (
        <Tag className={cx('card', tone !== 'default' && tone, dashed && 'dashed', className)} {...rest}>
            {children}
        </Tag>
    );
}

interface CardHeaderProps {
    /** The title of the card. */
    title: ReactNode;
    /** An icon before the title. */
    icon?: ReactNode;
    /** A number after the title, for example the count of the items. */
    count?: number;
    /** Smaller text below the title. */
    description?: ReactNode;
    /** Content after the title, for example a status. */
    meta?: ReactNode;
    /** Buttons at the right, for example an "Add" button or icon buttons. */
    actions?: ReactNode;
    /** The level of the title. The default is 3. */
    level?: 2 | 3 | 4;
    className?: string;
}

/** The header of a card: the title at the left and the actions at the right. */
export function CardHeader({ title, icon, count, description, meta, actions, level = 3, className }: CardHeaderProps) {
    const Heading = `h${level}` as const;
    return (
        <div className={cx('card-header', className)}>
            {icon && <span className="card-icon">{icon}</span>}
            <div className="card-heading">
                <div className="card-title-row">
                    <Heading className="card-title">{title}</Heading>
                    {count !== undefined && <span className="card-count">{count}</span>}
                    {meta}
                </div>
                {description && <div className="card-description">{description}</div>}
            </div>
            {actions && <div className="card-actions">{actions}</div>}
        </div>
    );
}

/** A part of a card with space around its content. */
export function CardBody({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={cx('card-body', className)} {...rest}>
            {children}
        </div>
    );
}

/** The last part of a card, for actions. The buttons go at the right. */
export function CardFooter({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={cx('card-footer', className)} {...rest}>
            {children}
        </div>
    );
}
