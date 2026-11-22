import { useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { shortcutOfEvent } from '@shared/prompt-templates';
import { inputClass } from '../components/ui';
import { cx } from '../components/ui/cx';

interface Props {
    id?: string;
    /** The key combination, for example "⌃⌥T", or undefined for no shortcut. */
    value: string | undefined;
    onChange(value: string | undefined): void;
    invalid?: boolean;
}

/** The keys that only change other keys. Alone, they are not a shortcut. */
const MODIFIER_KEYS = ['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn'];

/**
 * A field that records a keyboard shortcut. The user focuses the field and presses the keys. A key without ⌘, ⌃, or ⌥
 * is not a shortcut, so the field ignores it. Backspace or Delete removes the shortcut. Escape and Tab work as usual.
 */
export function KeyField({ id, value, onChange, invalid }: Props) {
    const [recording, setRecording] = useState(false);
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Tab' || MODIFIER_KEYS.includes(event.key)) return;
        if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.currentTarget.blur();
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if ((event.key === 'Backspace' || event.key === 'Delete') && !event.metaKey && !event.ctrlKey && !event.altKey) {
            onChange(undefined);
            return;
        }
        const text = shortcutOfEvent(event.nativeEvent);
        if (text) onChange(text);
    };
    return (
        <div className={inputClass('md', { invalid, className: cx('input-box', 'key-field', recording && 'recording') })}>
            {/* A text input would type the keys. This element only records them. */}
            <div
                id={id}
                role="textbox"
                tabIndex={0}
                aria-label="Shortcut"
                aria-invalid={invalid || undefined}
                className="input-inner key-field-value"
                onKeyDown={onKeyDown}
                onFocus={() => setRecording(true)}
                onBlur={() => setRecording(false)}
            >
                {value ?? <span className="placeholder">{recording ? 'Press the keys…' : 'No shortcut'}</span>}
            </div>
            {value && (
                <button type="button" className="input-clear" title="Remove the shortcut" aria-label="Remove the shortcut" onClick={() => onChange(undefined)}>
                    <X size={12} strokeWidth={2} />
                </button>
            )}
        </div>
    );
}
