import { useState, type ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import { Markdown } from '../Markdown';
import { Button, Card, CardBody, CardHeader, IconButton, cx } from '../ui';
import { InlineText } from './TaskEditors';
import type { TaskEdit } from './use-task-detail';

interface CardProps {
    title: ReactNode;
    /** A number after the title, for example the number of comments. A text such as "2/5" shows in the same style. */
    count?: number | string;
    /** Buttons at the right side of the header. */
    actions?: ReactNode;
    className?: string;
    children: ReactNode;
}

/** A part of the task details in a card with a border and a header. */
export function TaskCard({ title, count, actions, className, children }: CardProps) {
    return (
        <Card as="section" className={cx('task-card', className)}>
            <CardHeader
                title={title}
                count={typeof count === 'number' ? count : undefined}
                meta={typeof count === 'string' ? <span className="card-count">{count}</span> : undefined}
                actions={actions}
            />
            <CardBody>{children}</CardBody>
        </Card>
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
            <IconButton size="sm" icon={<Pencil size={13} strokeWidth={1.6} />} label="Edit the description" disabled={busy} onClick={start} />
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
                        <Button disabled={busy} onClick={() => setDraft(undefined)}>
                            Cancel
                        </Button>
                        <Button variant="primary" disabled={busy} title="Save (⌘↩)" onClick={onSave}>
                            Save
                        </Button>
                    </div>
                </div>
            ) : text ? (
                <Markdown className="task-markdown" text={description as string} />
            ) : editable ? (
                <Button variant="link" disabled={busy} onClick={start}>
                    Add a description
                </Button>
            ) : (
                <div className="task-field-empty">No description.</div>
            )}
        </TaskCard>
    );
}
