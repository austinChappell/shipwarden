import { useRef, useState } from 'react';
import { MAX_TITLE_LENGTH, type Plan } from '@shared/plans';
import { errorText } from '../util';
import { changePlanTitle } from './plan-actions';

/**
 * The title field of a plan that runs or ran. The title saves when the field loses the focus, or when the user pushes
 * Enter. Escape restores the saved title. An empty title does not save.
 */
export function PlanTitle({ plan, onError }: { plan: Plan; onError(message: string): void }) {
    /** The text while the user edits. Undefined when the field shows the saved title. */
    const [text, setText] = useState<string>();
    const cancel = useRef(false);

    const save = () => {
        const value = text;
        setText(undefined);
        if (cancel.current || value === undefined) {
            cancel.current = false;
            return;
        }
        changePlanTitle(plan.id, value).catch(error => onError(errorText(error)));
    };

    return (
        <input
            className="flow-title-input"
            value={text ?? plan.title}
            maxLength={MAX_TITLE_LENGTH}
            aria-label="Plan title"
            onChange={event => setText(event.target.value)}
            onBlur={save}
            onKeyDown={event => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') {
                    event.stopPropagation();
                    cancel.current = true;
                    event.currentTarget.blur();
                }
            }}
        />
    );
}
