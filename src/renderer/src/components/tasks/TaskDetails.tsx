import { ExternalLink, LoaderCircle, Pencil, Trash2 } from 'lucide-react';
import type { Task, TaskSource } from '@shared/tasks';
import { timeAgo } from '../../util';
import { openLink } from '../../links';
import { Markdown } from '../Markdown';
import { formatField } from './task-view-logic';
import { FieldRow, StatusDot, TaskAvatar, TaskLabels } from './TaskParts';
import { TaskActions } from './TaskActions';
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
}

/** The details of the selected task. The board and the list show them in a large dialog. */
export function TaskDetails({ source, selectedId, state, worktreeFor, repos, startRepo, chooseStartRepo, repoLabel, onOpenWorktree, onStartTask }: Props) {
    const { detail, statuses, comments, commentText, setCommentText, busy, detailError, editing, setEditing } = state;
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
                        {source.capabilities.edit && !editing && (
                            <button
                                className="icon-button"
                                title="Edit the title and the description"
                                disabled={busy}
                                onClick={() => setEditing({ title: detail.title, description: detail.description ?? '' })}
                            >
                                <Pencil size={14} strokeWidth={1.6} />
                            </button>
                        )}
                        {source.capabilities.delete && (
                            <button className="icon-button" title="Delete the task" disabled={busy} onClick={state.deleteTask}>
                                <Trash2 size={14} strokeWidth={1.6} />
                            </button>
                        )}
                    </div>
                    {editing ? (
                        <div className="task-edit">
                            <input
                                className="pr-title-input"
                                value={editing.title}
                                placeholder="Title"
                                aria-label="Title"
                                autoFocus
                                onChange={event => setEditing({ ...editing, title: event.target.value })}
                                onKeyDown={event => event.key === 'Enter' && state.saveEdit()}
                            />
                            <textarea
                                className="review-body task-edit-description"
                                value={editing.description}
                                placeholder="Description (Markdown)"
                                aria-label="Description"
                                onChange={event => setEditing({ ...editing, description: event.target.value })}
                            />
                            <div className="row-buttons">
                                <button className="button" disabled={busy} onClick={() => setEditing(undefined)}>
                                    Cancel
                                </button>
                                <button className="button primary" disabled={busy || !editing.title.trim()} onClick={state.saveEdit}>
                                    Save
                                </button>
                            </div>
                        </div>
                    ) : (
                        <h2 className="task-detail-title">{detail.title}</h2>
                    )}

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
                                <select
                                    className="tasks-select"
                                    value={detail.status.id}
                                    disabled={busy}
                                    onChange={event => state.changeStatus(event.target.value)}
                                >
                                    {statuses.map(status => (
                                        <option key={status.id} value={status.id}>
                                            {status.name}
                                        </option>
                                    ))}
                                </select>
                            ) : (
                                <span>
                                    <StatusDot status={detail.status} /> {detail.status.name}
                                </span>
                            )}
                            <span className="task-meta-label">Assignees</span>
                            {detail.assignees?.length ? (
                                <span className="task-people">
                                    {detail.assignees.map(person => (
                                        <span key={person.name} className="task-person">
                                            <TaskAvatar person={person} size={20} />
                                            {person.name}
                                        </span>
                                    ))}
                                </span>
                            ) : (
                                <span>Unassigned</span>
                            )}
                            {detail.priority && (
                                <>
                                    <span className="task-meta-label">Priority</span>
                                    <span>{detail.priority.name}</span>
                                </>
                            )}
                            {detail.labels && detail.labels.length > 0 && (
                                <>
                                    <span className="task-meta-label">Labels</span>
                                    <span className="task-labels">
                                        <TaskLabels labels={detail.labels} />
                                    </span>
                                </>
                            )}
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
                            {!editing &&
                                (detail.description?.trim() ? (
                                    <Markdown className="task-description" text={detail.description} />
                                ) : (
                                    <div className="task-description">No description.</div>
                                ))}

                            {source.capabilities.comments && (
                                <section className="task-comments">
                                    <div className="section-title">
                                        Comments <span>{comments.length}</span>
                                    </div>
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
                                </section>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
