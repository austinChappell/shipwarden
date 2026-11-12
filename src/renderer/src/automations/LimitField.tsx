import { useEffect, useState } from 'react';
import { Checkbox, Input } from '../components/ui';

interface Props {
    /** The limit, or null for no limit. */
    value: number | null;
    /** The number that the field shows when the user turns the limit on again, and when the text is not a number. */
    fallback: number;
    min: number;
    max: number;
    /** The step of the arrows. The field accepts any whole number in the range. */
    step: number;
    /** The unit after the field, for example "%" or "tokens". */
    unit: string;
    /** The accessible name of the field. */
    label: string;
    onSave(value: number | null): void;
}

/** Returns a whole number in the range. A value that is not a number gives the fallback. */
export function clampLimit(text: string, fallback: number, min: number, max: number): number {
    const value = text.trim() === '' ? Number.NaN : Number(text);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * A number field for a limit, with a "No limit" box. With "No limit", the field and its unit do not show. The field
 * keeps its number, so a second click on the box shows it again. The value saves when the field loses the focus or
 * on Enter. A value outside the range goes to the nearest end of the range.
 */
export function LimitField({ value, fallback, min, max, step, unit, label, onSave }: Props) {
    const [text, setText] = useState(String(value ?? fallback));
    useEffect(() => {
        if (value !== null) setText(String(value));
    }, [value]);
    const limited = value !== null;
    const commit = () => {
        const next = clampLimit(text, fallback, min, max);
        setText(String(next));
        if (next !== value) onSave(next);
    };
    return (
        <span className="automation-limit">
            {limited && (
                <>
                    <Input
                        type="number"
                        className="automation-limit-input"
                        min={min}
                        max={max}
                        step={step}
                        value={text}
                        aria-label={label}
                        onChange={event => setText(event.target.value)}
                        onBlur={commit}
                        onKeyDown={event => {
                            if (event.key === 'Enter') commit();
                        }}
                    />
                    <span className="automation-limit-unit">{unit}</span>
                </>
            )}
            <Checkbox
                className="automation-check"
                label="No limit"
                checked={!limited}
                onChange={checked => onSave(checked ? null : clampLimit(text, fallback, min, max))}
            />
        </span>
    );
}
