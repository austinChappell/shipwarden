import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { moveMenuFocus, useMenuClose } from '../use-menu';
import type { ControlSize } from './Button';
import { cx } from './cx';

/**
 * The look of a button group. "accent" is the soft accent fill of the recommended row action, for example Merge.
 * "primary" is the accent fill of the main action of a view.
 */
export type ButtonGroupTone = 'default' | 'accent' | 'primary';

interface GroupProps {
    tone?: ButtonGroupTone;
    /** The height of the buttons in the group. */
    size?: ControlSize;
    className?: string;
    /** The name of the group for a screen reader. */
    label?: string;
    /** The role of the group. Use "radiogroup" for a segmented control where the user selects one option. */
    role?: 'group' | 'radiogroup' | 'toolbar';
    /** Handles the keys of the group, for example the arrow keys of a radio group. */
    onKeyDown?(event: KeyboardEvent<HTMLDivElement>): void;
    children: ReactNode;
}

/**
 * Buttons that show as one control, for example a segmented control. The group has the border. A line separates the buttons.
 * Put `.button` elements in it. A menu in the group can use the group as its anchor.
 */
export function ButtonGroup({ tone = 'default', size = 'md', className, label, role = 'group', onKeyDown, children }: GroupProps) {
    return (
        // biome-ignore lint/a11y/useAriaPropsSupportedByRole: The role comes from the props. Each of the roles supports aria-label.
        <div className={cx('button-group', tone, size !== 'md' && size, className)} role={role} aria-label={label} onKeyDown={onKeyDown}>
            {children}
        </div>
    );
}

/** An item of the menu of a split button. */
export type SplitMenuItem =
    | {
          label: string;
          icon?: ReactNode;
          /** The key combination that also runs the item, for example "⌘O". */
          shortcut?: string;
          title?: string;
          disabled?: boolean;
          onSelect(): void;
      }
    | 'separator';

interface SplitProps {
    /** The main button. */
    label: ReactNode;
    icon?: ReactNode;
    title?: string;
    disabled?: boolean;
    onClick(): void;
    /** The items of the menu of the arrow button. */
    items: SplitMenuItem[];
    /** The tooltip of the arrow button. */
    menuTitle: string;
    tone?: ButtonGroupTone;
    size?: ControlSize;
    className?: string;
    /** The side of the group where the menu opens. */
    align?: 'left' | 'right';
}

/** A button group with a main button and an arrow button. The arrow button opens a menu of more actions. */
export function SplitButton({ label, icon, title, disabled, onClick, items, menuTitle, tone, size, className, align = 'right' }: SplitProps) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    useMenuClose(open, root, () => setOpen(false));
    useEffect(() => {
        if (open) root.current?.querySelector<HTMLButtonElement>('.button-group-item:not(:disabled)')?.focus();
    }, [open]);

    return (
        <div className="button-group-anchor" ref={root}>
            <ButtonGroup tone={tone} size={size} className={className}>
                <button type="button" className="button button-group-main" title={title} disabled={disabled} onClick={onClick}>
                    {icon}
                    {label}
                </button>
                <button
                    type="button"
                    className={`button button-group-arrow${open ? ' on' : ''}`}
                    title={menuTitle}
                    aria-label={menuTitle}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    onClick={() => setOpen(value => !value)}
                >
                    <ChevronDown size={14} strokeWidth={1.8} />
                </button>
            </ButtonGroup>
            {open && (
                <div
                    className={`button-group-menu ${align}`}
                    role="menu"
                    onKeyDown={event => moveMenuFocus(event, [...(root.current?.querySelectorAll<HTMLElement>('.button-group-item:not(:disabled)') ?? [])])}
                >
                    {items.map((item, index) =>
                        item === 'separator' ? (
                            // biome-ignore lint/suspicious/noArrayIndexKey: The items of one menu do not change order while it is open.
                            <div key={index} className="button-group-separator" role="separator" />
                        ) : (
                            <button
                                type="button"
                                key={item.label}
                                className="button-group-item"
                                role="menuitem"
                                title={item.title}
                                disabled={item.disabled}
                                onClick={() => {
                                    setOpen(false);
                                    item.onSelect();
                                }}
                            >
                                <span className="button-group-item-icon">{item.icon}</span>
                                <span className="button-group-item-label">{item.label}</span>
                                {item.shortcut && <kbd className="button-group-item-keys">{item.shortcut}</kbd>}
                            </button>
                        )
                    )}
                </div>
            )}
        </div>
    );
}
