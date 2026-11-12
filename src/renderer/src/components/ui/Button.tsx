import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './cx';

/**
 * The look of a button. The rules come from docs/design (board 2).
 * - "secondary": a neutral raised button. It is the default. Use it for all actions that are not the one below.
 * - "primary": the accent fill. Use it for one action per view: the main create or start action, or the action of an
 *   empty state.
 * - "accent": a soft accent fill. Use it only for the one recommended action of a row, for example "Merge".
 * - "success": a green fill. Use it only for an action that gives a "done" status, for example "Approve" on a pull
 *   request. The accent changes with the theme. Thus the accent must not show a status.
 * - "danger": red text on a secondary button. Use it for an action that deletes or stops something.
 * - "danger-solid": a red fill. Use it only for the confirm button of a confirm dialog.
 * - "ghost": no border and no background until the pointer is on it. Use it in toolbars and menus.
 * - "link": text only, with no box. Use it for a small action in a line of text.
 * - "link-danger": a red "link". Use it for a small action that deletes something, for example "Discard all".
 */
export type ButtonVariant = 'secondary' | 'primary' | 'accent' | 'success' | 'danger' | 'danger-solid' | 'ghost' | 'link' | 'link-danger';

/**
 * The height of a control. "sm" is 24 px, "md" is 28 px, and "lg" is 32 px.
 * Use "lg" in page headers, forms, and empty states. Use "md" in list rows.
 */
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
export function buttonClass(variant: ButtonVariant = 'secondary', size: ControlSize = 'md', active = false, className?: string): string {
    if (variant === 'link' || variant === 'link-danger') return cx('link-button', variant === 'link-danger' && 'danger', active && 'on', className);
    return cx('button', variant !== 'secondary' && variant, size !== 'md' && size, active && 'on', className);
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
