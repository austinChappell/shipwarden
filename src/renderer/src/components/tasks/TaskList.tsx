import { ChevronRight } from 'lucide-react';
import { collapsedByDefault, type StatusGroup, type Task } from '@shared/tasks';
import { itemKeys } from '../../keyboard/list-nav';
import { groupStatus, taskLabel } from './task-view-logic';
import { StatusDot, TaskAssignees, TaskLabels, WorktreeButton } from './TaskParts';

interface RowProps {
    task: Task;
    selected: boolean;
    worktree: string | undefined;
    onSelect(id: string): void;
    onSelectFromKeyboard(id: string): void;
    onOpenWorktree(path: string): void;
}

/** A task in the list view. */
export function TaskRow({ task, selected, worktree, onSelect, onSelectFromKeyboard, onOpenWorktree }: RowProps) {
    return (
        <div
            className={`task-row${selected ? ' selected' : ''}`}
            tabIndex={0}
            role="button"
            aria-label={taskLabel(task)}
            aria-pressed={selected}
            data-nav-item
            onClick={() => onSelect(task.id)}
            onKeyDown={itemKeys(() => onSelectFromKeyboard(task.id))}
        >
            <StatusDot status={task.status} />
            {task.key && <span className="task-key">{task.key}</span>}
            <span className="task-title">{task.title}</span>
            {worktree && <WorktreeButton worktree={worktree} onOpenWorktree={onOpenWorktree} />}
            <TaskLabels labels={task.labels} limit={2} />
            <TaskAssignees assignees={task.assignees} limit={2} />
        </div>
    );
}

interface Props {
    groups: StatusGroup[];
    selectedId: string | undefined;
    isCollapsed(key: string, byDefault: boolean): boolean;
    toggleGroup(key: string, byDefault: boolean): void;
    worktreeFor(task: Task): string | undefined;
    onSelect(id: string): void;
    onSelectFromKeyboard(id: string): void;
    onOpenWorktree(path: string): void;
}

/** The tasks in groups by status. The user can collapse each group. */
export function TaskStatusGroups({ groups, selectedId, isCollapsed, toggleGroup, worktreeFor, onSelect, onSelectFromKeyboard, onOpenWorktree }: Props) {
    return groups.map(group => {
        const key = group.key;
        const byDefault = collapsedByDefault(group.category);
        const closed = isCollapsed(key, byDefault);
        return (
            <section key={key}>
                <button className="status-group" data-nav-item aria-expanded={!closed} onClick={() => toggleGroup(key, byDefault)}>
                    <ChevronRight size={14} strokeWidth={1.8} className={`group-chevron${closed ? '' : ' open'}`} />
                    <StatusDot status={groupStatus(group)} />
                    <span className="status-group-name">{group.name}</span>
                    <span className="status-group-count">{group.tasks.length}</span>
                </button>
                {!closed &&
                    group.tasks.map(task => (
                        <TaskRow
                            key={task.id}
                            task={task}
                            selected={task.id === selectedId}
                            worktree={worktreeFor(task)}
                            onSelect={onSelect}
                            onSelectFromKeyboard={onSelectFromKeyboard}
                            onOpenWorktree={onOpenWorktree}
                        />
                    ))}
            </section>
        );
    });
}
