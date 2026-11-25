import { useRef, useState } from 'react';
import type { PullRequest } from '@shared/github';

/**
 * The title of a pull request. When the user can change the pull request, the title is a text field. The title saves
 * when the field loses the focus, or when the user pushes Enter. Escape restores the saved title. An empty title does
 * not save. A long title wraps to the next line. `onSave` shows its errors and does not reject.
 */
export function PullRequestTitle({ pr, className, onSave }: { pr: PullRequest; className: string; onSave(title: string): Promise<unknown> }) {
    /** The text while the user edits. Undefined when the field shows the saved title. */
    const [text, setText] = useState<string>();
    /** The new title while the host saves it. The field shows it, so the old title does not show again. */
    const [saving, setSaving] = useState<string>();
    const cancel = useRef(false);

    if (!pr.viewerCanUpdate) return <span className={className}>{pr.title}</span>;

    const save = () => {
        const value = text?.trim();
        setText(undefined);
        if (cancel.current) {
            cancel.current = false;
            return;
        }
        if (!value || value === pr.title) return;
        setSaving(value);
        void onSave(value).finally(() => setSaving(undefined));
    };

    return (
        <textarea
            className={`${className} pr-title-input`}
            rows={1}
            value={text ?? saving ?? pr.title}
            aria-label="Pull request title"
            spellCheck
            // A title has one line. A paste with line breaks becomes one line.
            onChange={event => setText(event.target.value.replace(/\s*[\r\n]+\s*/g, ' '))}
            onBlur={save}
            onKeyDown={event => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    event.currentTarget.blur();
                }
                if (event.key === 'Escape') {
                    event.stopPropagation();
                    cancel.current = true;
                    event.currentTarget.blur();
                }
            }}
        />
    );
}
