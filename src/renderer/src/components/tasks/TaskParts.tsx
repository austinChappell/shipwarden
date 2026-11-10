import { useState } from 'react';
import { GitBranch } from 'lucide-react';
import type { Task, TaskPerson, TaskStatus } from '@shared/tasks';
import { personInitials } from './task-view-logic';

export function StatusDot({ status }: { status: TaskStatus }) {
    return <span className={`task-status-dot ${status.category}`} style={status.color ? { background: status.color } : undefined} title={status.name} />;
}

/** The labels of a task. `limit` sets the maximum number of labels. */
export function TaskLabels({ labels, limit }: { labels: Task['labels']; limit?: number }) {
    return (
        <>
            {labels?.slice(0, limit).map(label => (
                <span key={label.name} className="task-label" style={label.color ? { borderColor: label.color } : undefined}>
                    {label.name}
                </span>
            ))}
        </>
    );
}

/** The worktree button of a task card or row. It opens the worktree, not the task. */
export function WorktreeButton({ worktree, onOpenWorktree }: { worktree: string; onOpenWorktree(path: string): void }) {
    return (
        <button
            className="icon-button task-linked"
            title="Open the worktree of this task"
            onClick={event => {
                event.stopPropagation();
                onOpenWorktree(worktree);
            }}
        >
            <GitBranch size={13} strokeWidth={1.6} />
        </button>
    );
}

export function FieldRow({ label, value }: { label: string; value: string }) {
    return (
        <>
            <span className="task-meta-label">{label}</span>
            <span>{value}</span>
        </>
    );
}

/** The picture of a person. Without a picture, or when the picture does not load, it shows the initials. */
export function TaskAvatar({ person, size = 18 }: { person: TaskPerson; size?: number }) {
    const [failed, setFailed] = useState(false);
    const style = { width: size, height: size, fontSize: Math.round(size * 0.45) };
    if (person.avatarUrl && !failed) {
        return <img className="task-avatar" src={person.avatarUrl} alt="" style={style} referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
    }
    return (
        <span className="task-avatar initials" style={style} aria-hidden="true">
            {personInitials(person.name)}
        </span>
    );
}

/** The avatars of the assignees in an overlapped row. `limit` sets the maximum number of avatars. A "+N" shows the remaining number. */
export function TaskAssignees({ assignees, limit = 3, size }: { assignees: Task['assignees']; limit?: number; size?: number }) {
    if (!assignees?.length) return null;
    const names = assignees.map(person => person.name).join(', ');
    const extra = assignees.length - limit;
    return (
        <span className="task-assignees" title={`Assignees: ${names}`} role="img" aria-label={`Assignees: ${names}`}>
            {assignees.slice(0, limit).map(person => (
                <TaskAvatar key={person.name} person={person} size={size} />
            ))}
            {extra > 0 && <span className="task-assignees-more">+{extra}</span>}
        </span>
    );
}
