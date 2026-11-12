import type { InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from 'react';
import { Search, X } from 'lucide-react';
import type { ControlSize } from './Button';
import { cx } from './cx';

/** Returns the classes of a text field. Use it for an element that must look like a field but is not an `Input`. */
export function inputClass(size: ControlSize = 'md', options: { mono?: boolean; invalid?: boolean; className?: string } = {}): string {
    return cx('input', size !== 'md' && size, options.mono && 'mono', options.invalid && 'invalid', options.className);
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
    size?: ControlSize;
    /** Shows the text in the monospace font, for example for a command or a path. */
    mono?: boolean;
    /** Shows the field in the danger color, for example when the value is not valid. */
    invalid?: boolean;
    /** An icon at the left, in the field. */
    icon?: ReactNode;
    /** Content at the right, in the field, for example a unit or a clear button. */
    suffix?: ReactNode;
    ref?: Ref<HTMLInputElement>;
}

/**
 * A one-line text field. It is for all the input types that show text: text, number, password, email, url, and time.
 * With `icon` or `suffix`, a box holds the field and the extra content. The `className` goes on the box.
 */
export function Input({ size, mono, invalid, icon, suffix, className, type = 'text', ...rest }: InputProps) {
    if (icon === undefined && suffix === undefined) {
        return <input type={type} className={inputClass(size, { mono, invalid, className })} aria-invalid={invalid || undefined} {...rest} />;
    }
    return (
        <div className={inputClass(size, { mono, invalid, className: cx('input-box', rest.disabled && 'disabled', className) })}>
            {icon && <span className="input-icon">{icon}</span>}
            <input type={type} className="input-inner" aria-invalid={invalid || undefined} {...rest} />
            {suffix && <span className="input-suffix">{suffix}</span>}
        </div>
    );
}

export interface SearchInputProps extends Omit<InputProps, 'icon' | 'suffix' | 'type' | 'onChange' | 'value'> {
    value: string;
    onChange(value: string): void;
    /** Shows a button that clears the text. The default is true. */
    clearable?: boolean;
}

/** A text field for a search. It has a search icon and a button that clears the text. */
export function SearchInput({ value, onChange, clearable = true, placeholder = 'Search', ...rest }: SearchInputProps) {
    return (
        <Input
            {...rest}
            type="text"
            spellCheck={false}
            value={value}
            placeholder={placeholder}
            onChange={event => onChange(event.target.value)}
            icon={<Search size={13} strokeWidth={1.8} />}
            suffix={
                clearable && value ? (
                    <button type="button" className="input-clear" title="Clear the search" aria-label="Clear the search" onClick={() => onChange('')}>
                        <X size={12} strokeWidth={2} />
                    </button>
                ) : null
            }
        />
    );
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
    mono?: boolean;
    invalid?: boolean;
    ref?: Ref<HTMLTextAreaElement>;
}

/** A text field with more than one line. */
export function TextArea({ mono, invalid, className, ...rest }: TextAreaProps) {
    return <textarea className={cx('input', 'textarea', mono && 'mono', invalid && 'invalid', className)} aria-invalid={invalid || undefined} {...rest} />;
}

interface FieldProps {
    /** The name of the field. */
    label: ReactNode;
    /** The id of the control. A click on the label then moves the focus to the control. */
    htmlFor?: string;
    /** Help text below the control. */
    hint?: ReactNode;
    /** An error below the control. It replaces the hint. */
    error?: ReactNode;
    className?: string;
    children: ReactNode;
}

/** A label above a control, with help text or an error below it. Use it in forms and dialogs. */
export function Field({ label, htmlFor, hint, error, className, children }: FieldProps) {
    return (
        <div className={cx('field', className)}>
            <label className="field-label" htmlFor={htmlFor}>
                {label}
            </label>
            {children}
            {error ? <div className="field-error">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
        </div>
    );
}
