import { useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { cx } from './cx';

interface FilterFieldProps {
    value: string;
    onChange(value: string): void;
    /** The text when the field is empty. Write "Filter <things>", for example "Filter pull requests". */
    placeholder: string;
    /** The name of the field for a screen reader. The default is the placeholder. */
    label?: string;
    className?: string;
    /** Runs a key in the field, for example Enter or an arrow key. */
    onKeyDown?(event: React.KeyboardEvent<HTMLInputElement>): void;
}

/** True when a key goes to a field or another control that uses the text keys. */
function isTyping(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || !!target.closest('input, textarea, select, [role="textbox"], .monaco-editor, .xterm');
}

/**
 * The filter field of a page header (docs/design, board 2): 240 px, with a search icon and a "/" hint. The "/" key
 * moves the focus to the field when the focus is not in another field. Escape clears the field.
 * Use "Filter" in the placeholder. "Search" is for a future global search.
 */
export function FilterField({ value, onChange, placeholder, label, className, onKeyDown }: FilterFieldProps) {
    const input = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
            const field = input.current;
            // A hidden page keeps its header in the document. Only the visible field takes the key.
            if (!field || field.offsetParent === null) return;
            event.preventDefault();
            field.focus();
            field.select();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    return (
        <div className={cx('filter-field', className)}>
            <Search size={14} strokeWidth={1.8} aria-hidden="true" />
            <input
                ref={input}
                type="text"
                spellCheck={false}
                value={value}
                placeholder={placeholder}
                aria-label={label ?? placeholder}
                onChange={event => onChange(event.target.value)}
                onKeyDown={event => {
                    if (event.key === 'Escape' && value) {
                        event.stopPropagation();
                        onChange('');
                    }
                    onKeyDown?.(event);
                }}
            />
            {value ? (
                <button type="button" className="input-clear" title="Clear the filter" aria-label="Clear the filter" onClick={() => onChange('')}>
                    <X size={12} strokeWidth={2} />
                </button>
            ) : (
                <kbd>/</kbd>
            )}
        </div>
    );
}
