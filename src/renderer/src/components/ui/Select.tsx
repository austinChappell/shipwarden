import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Popover } from './Popover';
import type { ControlSize } from './Button';
import { cx } from './cx';
import { inputClass } from './Input';

export interface SelectOption<T extends string = string> {
    value: T;
    label: string;
    /** A small element before the label, for example a status dot. */
    icon?: ReactNode;
    disabled?: boolean;
}

interface Props<T extends string> {
    value: T | undefined;
    options: readonly SelectOption<T>[];
    onChange(value: T): void;
    /** The text on the button when no option has the value. */
    placeholder?: string;
    disabled?: boolean;
    title?: string;
    'aria-label'?: string;
    /** More classes for the button, for example for its width. The look comes from the field style. */
    className?: string;
    size?: ControlSize;
    /** Shows the button in the danger color, for example when the selected value is not valid. */
    invalid?: boolean;
    /** The content of the button. The default is the label of the selected option and an arrow. */
    children?: ReactNode;
}

/** The time in milliseconds that the typed letters stay in the type-ahead search. */
const TYPE_AHEAD_MS = 700;

/**
 * Returns the index of the next option that starts with the typed text, from `start`. Disabled options do not match.
 * Returns -1 when no option matches.
 */
export function typeAheadIndex(options: readonly { label: string; disabled?: boolean }[], text: string, start: number): number {
    const wanted = text.toLowerCase();
    for (let step = 0; step < options.length; step++) {
        const index = (start + step) % options.length;
        if (!options[index].disabled && options[index].label.toLowerCase().startsWith(wanted)) return index;
    }
    return -1;
}

/** Returns the index of the next option that is not disabled, in the direction `step`. Returns `from` when there is none. */
export function nextEnabled(options: readonly { disabled?: boolean }[], from: number, step: 1 | -1): number {
    for (let index = from + step; index >= 0 && index < options.length; index += step) {
        if (!options[index].disabled) return index;
    }
    return from;
}

/** A select in the style of the app. It replaces the native select, which has the look of the operating system. */
export function Select<T extends string>({
    value,
    options,
    onChange,
    placeholder = 'Select',
    disabled,
    title,
    className,
    size,
    invalid,
    children,
    ...rest
}: Props<T>) {
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const trigger = useRef<HTMLButtonElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const typed = useRef({ text: '', at: 0 });
    const id = useId();
    const selected = options.find(option => option.value === value);

    const show = () => {
        const index = options.findIndex(option => option.value === value);
        setActive(index >= 0 ? index : nextEnabled(options, -1, 1));
        setOpen(true);
    };

    const hide = (focus = true) => {
        setOpen(false);
        if (focus) trigger.current?.focus();
    };

    const choose = (option: SelectOption<T> | undefined) => {
        if (!option || option.disabled) return;
        hide();
        if (option.value !== value) onChange(option.value);
    };

    useEffect(() => {
        if (open) list.current?.focus();
    }, [open]);

    // Keep the active option visible when the keys move it.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The effect must run when the active option changes. It finds the option in the page.
    useEffect(() => {
        list.current?.querySelector('.select-option.active')?.scrollIntoView({ block: 'nearest' });
    }, [active, open]);

    const onTriggerKey = (event: KeyboardEvent) => {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            show();
        }
    };

    const onListKey = (event: KeyboardEvent) => {
        const key = event.key;
        if (key === 'Escape') {
            // Escape closes only the list. A dialog around the select stays open.
            event.preventDefault();
            event.stopPropagation();
            hide();
        } else if (key === 'Tab') {
            event.preventDefault();
            hide();
        } else if (key === 'ArrowDown' || key === 'ArrowUp') {
            event.preventDefault();
            setActive(index => nextEnabled(options, index, key === 'ArrowDown' ? 1 : -1));
        } else if (key === 'Home' || key === 'End') {
            event.preventDefault();
            setActive(key === 'Home' ? nextEnabled(options, -1, 1) : nextEnabled(options, options.length, -1));
        } else if (key === 'Enter' || key === ' ') {
            event.preventDefault();
            choose(options[active]);
        } else if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
            // Type-ahead: the typed letters select the next option that starts with them.
            const now = Date.now();
            const text = now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text + key : key;
            typed.current = { text, at: now };
            const index = typeAheadIndex(options, text, text.length === 1 ? active + 1 : active);
            if (index >= 0) setActive(index);
        }
    };

    return (
        <>
            <button
                ref={trigger}
                type="button"
                className={inputClass(size, { invalid, className: cx('select-button', open && 'on', className) })}
                disabled={disabled}
                title={title}
                aria-label={rest['aria-label']}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? `${id}-list` : undefined}
                onClick={() => (open ? hide(false) : show())}
                onKeyDown={onTriggerKey}
            >
                {children ?? (
                    <>
                        {selected?.icon}
                        <span className={`select-value${selected ? '' : ' placeholder'}`}>{selected?.label ?? placeholder}</span>
                        <ChevronDown size={13} strokeWidth={1.8} />
                    </>
                )}
            </button>
            {open && (
                <Popover anchor={trigger} onClose={() => hide(false)} className="select-popover">
                    <div
                        ref={list}
                        id={`${id}-list`}
                        className="select-list"
                        role="listbox"
                        tabIndex={-1}
                        aria-label={rest['aria-label'] ?? title}
                        aria-activedescendant={options[active] ? `${id}-option-${active}` : undefined}
                        onKeyDown={onListKey}
                        onBlur={event => {
                            if (!event.relatedTarget || event.relatedTarget !== trigger.current) setOpen(false);
                        }}
                    >
                        {options.map((option, index) => (
                            <div
                                key={option.value}
                                id={`${id}-option-${index}`}
                                role="option"
                                aria-selected={option.value === value}
                                aria-disabled={option.disabled || undefined}
                                className={`select-option${index === active ? ' active' : ''}${option.disabled ? ' disabled' : ''}`}
                                onMouseMove={() => !option.disabled && setActive(index)}
                                onMouseDown={event => event.preventDefault()}
                                onClick={() => choose(option)}
                            >
                                <span className="select-check">{option.value === value && <Check size={13} strokeWidth={2} />}</span>
                                {option.icon}
                                <span className="select-label">{option.label}</span>
                            </div>
                        ))}
                    </div>
                </Popover>
            )}
        </>
    );
}
