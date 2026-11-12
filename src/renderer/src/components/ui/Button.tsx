import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './cx';

/**
 * The look of a button.
 * - "default": a border and a raised background. Use it for most actions.
 * - "primary": the accent color as an outline. Use it for the main action of a section.
 * - "solid": a fill in the accent color. Use it for the one main action of a page or a dialog.
 * - "danger": the danger color. Use it for an action that deletes or stops something.
 * - "approve": the ok color, for example "Approve".
 * - "merge": the purple of the merge button.
 * - "ghost": no border and no background until the pointer is on it. Use it in toolbars and rows.
 * - "link": text only, with no box. Use it for a small action in a line of text.
 */
export type ButtonVariant = 'default' | 'primary' | 'solid' | 'danger' | 'approve' | 'merge' | 'ghost' | 'link';

/** The height of a control. "sm" is 24 px, "md" is 28 px, and "lg" is 32 px. */
export type ControlSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ControlSize;
    /** An icon before the label. */
    icon?: ReactNode;
    /** An icon after the label, for example an arrow. */
    iconEnd?: ReactNode;
    /** Shows the button as pressed, for example while its menu is open. */
    active?: boolean;
    ref?: Ref<HTMLButtonElement>;
}

/** Returns the classes of a button. Use it for an element that must look like a button but is not a `Button`. */
export function buttonClass(variant: ButtonVariant = 'default', size: ControlSize = 'md', active = false, className?: string): string {
    if (variant === 'link') return cx('link-button', active && 'on', className);
    return cx('button', variant !== 'default' && variant, size !== 'md' && size, active && 'on', className);
}

/**
 * The button of the app. The type is "button" by default, so a button in a form does not send the form.
 * Set `type="submit"` for the button that sends a form.
 */
export function Button({ variant, size, icon, iconEnd, active, className, type = 'button', children, ...rest }: ButtonProps) {
    return (
        <button
            type={type}
            className={buttonClass(variant, size, active, cx(icon !== undefined && children == null && iconEnd === undefined && 'icon-only', className))}
            {...rest}
        >
            {icon}
            {children}
            {iconEnd}
        </button>
    );
}

/**
 * The look of an icon button.
 * - "ghost": no border and no background until the pointer is on it. Use it in toolbars, headers, and rows.
 * - "outline": a border and a raised background, the same as a default `Button`. Use it next to other buttons.
 */
export type IconButtonVariant = 'ghost' | 'outline';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
    /** The icon. Use a lucide icon at 14 px for "sm" and "md", and at 16 px for "lg". */
    icon: ReactNode;
    /** The name of the action. It is the tooltip and the name for a screen reader. */
    label: string;
    variant?: IconButtonVariant;
    size?: ControlSize;
    /** Shows the button as pressed, for example for a toggle that is on. */
    active?: boolean;
    /** The tone of the icon when the pointer is on it. "danger" is for an action that deletes something. */
    tone?: 'default' | 'danger';
    /** Content after the icon, for example a count. */
    children?: ReactNode;
    ref?: Ref<HTMLButtonElement>;
}

/** Returns the classes of an icon button. */
export function iconButtonClass(variant: IconButtonVariant = 'ghost', size: ControlSize = 'md', active = false, className?: string): string {
    return cx('icon-button', variant === 'outline' && 'outline', size !== 'md' && size, active && 'on', className);
}

/** A square button with only an icon. The label is the tooltip and the name for a screen reader. */
export function IconButton({ icon, label, variant, size, active, tone, className, title, type = 'button', children, ...rest }: IconButtonProps) {
    return (
        <button
            type={type}
            className={iconButtonClass(variant, size, active, cx(tone === 'danger' && 'danger', children !== undefined && 'with-text', className))}
            title={title ?? label}
            aria-label={label}
            {...rest}
        >
            {icon}
            {children}
        </button>
    );
}
