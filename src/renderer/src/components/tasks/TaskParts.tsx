import { GitBranch } from 'lucide-react';
import type { Task, TaskStatus } from '@shared/tasks';

export function StatusDot({ status }: { status: TaskStatus }) {
    return <span className={`task-status-dot ${status.category}`} style={status.color ? { background: status.color } : undefined} title={status.name} />;
}

/** The labels of a task. `limit` sets the maximum number of labels. */
export function TaskLabels({ labels, limit }: { labels: Task['labels']; limit?: number }) {
    return (
        <>
            {labels?.slice(0, limit).map(label => (
                <span key={label.name} className="task-label" style={label.color ? { borderColor: label.color } : undefined}>{label.name}</span>
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
