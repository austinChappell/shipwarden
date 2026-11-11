import { ExternalLink, LoaderCircle, Trash2 } from 'lucide-react';
import type { Task, TaskSource } from '@shared/tasks';
import { timeAgo } from '../../util';
import { openLink } from '../../links';
import { Markdown } from '../Markdown';
import { Select } from '../Select';
import { editableParts, formatField } from './task-view-logic';
import { FieldRow, StatusDot, TaskAvatar } from './TaskParts';
import { TaskActions } from './TaskActions';
import { AttachmentsSection, ChecklistsSection, CustomFieldsSection, DetailMetaRows, RelatedTasksSection } from './TaskDetailSections';
import { EditableMetaRows } from './TaskMetaEditors';
import { DescriptionCard, TaskCard, TaskTitle } from './TaskBody';
import type { useTaskDetail } from './use-task-detail';

interface Props {
    source: TaskSource;
    selectedId: string | undefined;
    /** The state and the actions of the selected task. */
    state: ReturnType<typeof useTaskDetail>;
    worktreeFor(task: Task): string | undefined;
    repos: string[];
    startRepo: string;
    chooseStartRepo(repo: string): void;
    repoLabel(repo: string): string;
    onOpenWorktree(path: string): void;
    onStartTask(task: Task, connectionId: string, pluginId: string, repo: string): Promise<void>;
    /** A loaded task with the ID, for the titles of subtasks and linked tasks. */
    findTask(id: string): Task | undefined;
    /** Opens another task in the details, for example a subtask. */
    onOpenTask(id: string): void;
}

/** The details of the selected task. The board and the list show them in a large dialog. */
export function TaskDetails({
    source,
    selectedId,
    state,
    worktreeFor,
    repos,
    startRepo,
    chooseStartRepo,
    repoLabel,
    onOpenWorktree,
    onStartTask,
    findTask,
    onOpenTask
}: Props) {
    const { detail, statuses, comments, commentText, setCommentText, busy, detailError, editing, setEditing } = state;
    const editable = detail ? editableParts(detail, source.capabilities) : {};
    return (
        <>
            {selectedId && !detail && !detailError && (
                <div className="panel-message">
                    <LoaderCircle size={14} className="spin" /> Loading…
                </div>
            )}
            {detailError && <div className="form-error task-detail-error">{detailError}</div>}
            {detail && (
                <div className="task-detail-scroll">
                    <div className="task-detail-top">
                        {detail.key && <span className="task-key">{detail.key}</span>}
                        {detail.url && (
                            <button className="link-button" onClick={event => openLink(detail.url!, event)}>
                                Open <ExternalLink size={12} strokeWidth={1.6} />
                            </button>
                        )}
                        <span className="header-spacer" />
                        {source.capabilities.delete && (
                            <button className="icon-button" title="Delete the task" disabled={busy} onClick={state.deleteTask}>
                                <Trash2 size={14} strokeWidth={1.6} />
                            </button>
                        )}
                    </div>
                    <TaskTitle key={detail.id} title={detail.title} editable={!!editable.title} busy={busy} onSave={state.saveTitle} />

                    <TaskActions
                        task={detail}
                        source={source}
                        busy={busy}
                        worktree={worktreeFor(detail)}
                        repos={repos}
                        startRepo={startRepo}
                        chooseStartRepo={chooseStartRepo}
                        repoLabel={repoLabel}
                        onOpenWorktree={onOpenWorktree}
                        onStartTask={onStartTask}
                        act={state.act}
                        runAction={state.runAction}
                    />

                    <div className="task-detail-body">
                        <div className="task-meta">
                            <span className="task-meta-label">Status</span>
                            {source.capabilities.update && statuses.length > 0 ? (
                                <Select
                                    value={detail.status.id}
                                    disabled={busy}
                                    aria-label="Status"
                                    options={statuses.map(status => ({ value: status.id, label: status.name, icon: <StatusDot status={status} /> }))}
                                    onChange={state.changeStatus}
                                />
                            ) : (
                                <span>
                                    <StatusDot status={detail.status} /> {detail.status.name}
                                </span>
                            )}
                            <EditableMetaRows task={detail} editable={editable} canLoad={!!source.capabilities.options} busy={busy} state={state} />
                            <DetailMetaRows details={detail.details} editable={editable} />
                            {source.fields.map(field => (
                                <FieldRow key={field.id} label={field.label} value={formatField(detail.fields?.[field.id], field.type)} />
                            ))}
                            {detail.updatedAt && (
                                <>
                                    <span className="task-meta-label">Updated</span>
                                    <span>{timeAgo(detail.updatedAt)}</span>
                                </>
                            )}
                        </div>

                        <div className="task-detail-main">
                            <DescriptionCard
                                description={detail.description}
                                editable={!!editable.description}
                                busy={busy}
                                draft={editing}
                                setDraft={setEditing}
                                onSave={state.saveEdit}
                            />

                            <CustomFieldsSection
                                key={detail.id}
                                fields={detail.details?.customFields}
                                canUpdate={!!source.capabilities.update}
                                canLoad={!!source.capabilities.options}
                                busy={busy}
                                onChange={(id, value) => state.updateTask({ customField: { id, value } })}
                                loadOptions={state.loadOptions}
                            />
                            <RelatedTasksSection details={detail.details} findTask={findTask} onOpenTask={onOpenTask} />
                            <ChecklistsSection
                                checklists={detail.details?.checklists}
                                busy={busy}
                                onToggle={editable.checklists ? (id, done) => state.updateTask({ checklistItem: { id, done } }) : undefined}
                            />
                            <AttachmentsSection attachments={detail.details?.attachments} />

                            {source.capabilities.comments && (
                                <TaskCard title="Comments" count={comments.length} className="task-comments">
                                    {comments.map(comment => (
                                        <div key={comment.id} className="thread-comment">
                                            <div className="comment-author">
                                                {comment.author && <TaskAvatar person={comment.author} size={18} />}
                                                {comment.author?.name ?? 'unknown'} {comment.createdAt && <span>{timeAgo(comment.createdAt)}</span>}
                                            </div>
                                            <Markdown className="comment-body" text={comment.body} />
                                        </div>
                                    ))}
                                    <textarea
                                        className="review-body"
                                        value={commentText}
                                        placeholder="Add a comment"
                                        onChange={event => setCommentText(event.target.value)}
                                    />
                                    <div className="row-buttons">
                                        <button className="button" disabled={busy || !commentText.trim()} onClick={state.addComment}>
                                            Comment
                                        </button>
                                    </div>
                                </TaskCard>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
