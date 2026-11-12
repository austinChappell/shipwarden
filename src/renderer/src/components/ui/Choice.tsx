import { useEffect, useRef, type ReactNode } from 'react';
import { cx } from './cx';

interface CheckboxProps {
    checked: boolean;
    onChange(checked: boolean): void;
    /** The text next to the box. Without a label, set `aria-label`. */
    label?: ReactNode;
    /** Smaller text below the label. */
    description?: ReactNode;
    /** Shows a line in the box, for a group where only some items are on. */
    indeterminate?: boolean;
    disabled?: boolean;
    title?: string;
    'aria-label'?: string;
    className?: string;
}

/** A checkbox with its label. A click on the label also changes the value. */
export function Checkbox({ checked, onChange, label, description, indeterminate = false, disabled, title, className, ...rest }: CheckboxProps) {
    const box = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (box.current) box.current.indeterminate = indeterminate;
    }, [indeterminate]);

    const input = (
        <input
            ref={box}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            aria-label={rest['aria-label']}
            title={label === undefined ? title : undefined}
            onChange={event => onChange(event.target.checked)}
        />
    );
    if (label === undefined) return input;
    return (
        // biome-ignore lint/a11y/noLabelWithoutControl: The checkbox is in the `input` value. The label holds it.
        <label className={cx('choice', disabled && 'disabled', className)} title={title}>
            {input}
            <span className="choice-text">
                <span className="choice-label">{label}</span>
                {description && <span className="choice-description">{description}</span>}
            </span>
        </label>
    );
}

interface RadioProps {
    checked: boolean;
    /** Runs when the user selects this option. */
    onSelect(): void;
    label: ReactNode;
    description?: ReactNode;
    /** The name of the group. The arrow keys move between the options of one group. */
    name?: string;
    disabled?: boolean;
    title?: string;
    className?: string;
}

/** An option of a group where the user can select only one option. */
export function Radio({ checked, onSelect, label, description, name, disabled, title, className }: RadioProps) {
    return (
        <label className={cx('choice', disabled && 'disabled', className)} title={title}>
            <input type="radio" name={name} checked={checked} disabled={disabled} onChange={() => onSelect()} />
            <span className="choice-text">
                <span className="choice-label">{label}</span>
                {description && <span className="choice-description">{description}</span>}
            </span>
        </label>
    );
}

interface SwitchProps {
    checked: boolean;
    onChange(value: boolean): void;
    /** The name of the setting. It is the tooltip and the name for a screen reader. */
    title: string;
    disabled?: boolean;
}

/** An on/off switch. Use it for a setting that has an effect immediately. */
export function Switch({ checked, title, disabled, onChange }: SwitchProps) {
    return (
        <label className={cx('switch', disabled && 'disabled')} title={title}>
            <input
                type="checkbox"
                role="switch"
                checked={checked}
                aria-checked={checked}
                disabled={disabled}
                aria-label={title}
                onChange={event => onChange(event.target.checked)}
            />
            <span />
        </label>
    );
}
