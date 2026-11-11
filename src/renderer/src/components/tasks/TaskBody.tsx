import { useState, type ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import { Markdown } from '../Markdown';
import { InlineText } from './TaskEditors';
import type { TaskEdit } from './use-task-detail';

interface CardProps {
    title: ReactNode;
    /** A number after the title, for example the number of comments. */
    count?: ReactNode;
    /** Buttons at the right side of the header. */
    actions?: ReactNode;
    className?: string;
    children: ReactNode;
}

/** A part of the task details in a card with a border and a header. */
export function TaskCard({ title, count, actions, className, children }: CardProps) {
    return (
        <section className={`task-card${className ? ` ${className}` : ''}`}>
            <header className="task-card-header">
                <span className="task-card-title">{title}</span>
                {count !== undefined && <span className="task-card-count">{count}</span>}
                {actions && <span className="task-card-actions">{actions}</span>}
            </header>
            <div className="task-card-body">{children}</div>
        </section>
    );
}

interface TitleProps {
    title: string;
    editable: boolean;
    busy: boolean;
    /** Saves the title. It returns an error text for a title that is not valid. */
    onSave(title: string): string | undefined;
}

/** The title of the task. When the plugin can change it, a click changes it to an input. */
export function TaskTitle({ title, editable, busy, onSave }: TitleProps) {
    if (!editable) return <h2 className="task-detail-title">{title}</h2>;
    return (
        <h2 className="task-detail-title editable">
            <InlineText label="Title" value={title} disabled={busy} onSave={onSave}>
                {title}
            </InlineText>
        </h2>
    );
}

interface DescriptionProps {
    description: string | undefined;
    editable: boolean;
    busy: boolean;
    /** The draft while the user edits the description. */
    draft: TaskEdit | undefined;
    setDraft(draft: TaskEdit | undefined): void;
    onSave(): void;
}

/**
 * The description of the task as Markdown, in a card. When the plugin can change it, "Edit" opens a Markdown editor
 * with a "Write" tab and a "Preview" tab. Cmd+Enter saves the draft.
 */
export function DescriptionCard({ description, editable, busy, draft, setDraft, onSave }: DescriptionProps) {
    const [preview, setPreview] = useState(false);
    const text = description?.trim() ?? '';
    const start = () => {
        setPreview(false);
        setDraft({ description: description ?? '' });
    };

    const actions =
        editable && !draft ? (
            <button type="button" className="icon-button" title="Edit the description" disabled={busy} onClick={start}>
                <Pencil size={13} strokeWidth={1.6} />
            </button>
        ) : undefined;

    return (
        <TaskCard title="Description" actions={actions} className="task-description-card">
            {draft ? (
                <div className="markdown-editor">
                    <div className="markdown-editor-tabs" role="tablist">
                        <button type="button" role="tab" aria-selected={!preview} className={preview ? '' : 'on'} onClick={() => setPreview(false)}>
                            Write
                        </button>
                        <button type="button" role="tab" aria-selected={preview} className={preview ? 'on' : ''} onClick={() => setPreview(true)}>
                            Preview
                        </button>
                        <span className="markdown-editor-hint">Markdown is supported</span>
                    </div>
                    {preview ? (
                        draft.description.trim() ? (
                            <Markdown className="task-markdown markdown-editor-preview" text={draft.description} />
                        ) : (
                            <div className="markdown-editor-preview task-field-empty">Nothing to preview.</div>
                        )
                    ) : (
                        <textarea
                            className="markdown-editor-input"
                            value={draft.description}
                            placeholder="Write the description in Markdown"
                            aria-label="Description"
                            spellCheck
                            autoFocus
                            onChange={event => setDraft({ description: event.target.value })}
                            onKeyDown={event => {
                                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                                    event.preventDefault();
                                    onSave();
                                }
                            }}
                        />
                    )}
                    <div className="row-buttons">
                        <button type="button" className="button" disabled={busy} onClick={() => setDraft(undefined)}>
                            Cancel
                        </button>
                        <button type="button" className="button primary" disabled={busy} title="Save (⌘↩)" onClick={onSave}>
                            Save
                        </button>
                    </div>
                </div>
            ) : text ? (
                <Markdown className="task-markdown" text={description as string} />
            ) : editable ? (
                <button type="button" className="link-button task-description-add" disabled={busy} onClick={start}>
                    Add a description
                </button>
            ) : (
                <div className="task-field-empty">No description.</div>
            )}
        </TaskCard>
    );
}
