import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { collapsedByDefault, type StatusGroup, type Task } from '@shared/tasks';
import { itemKeys, moveListFocus } from '../../keyboard/list-nav';
import { acceptsDrop, groupStatus, neighborColumn, taskLabel } from './task-view-logic';
import { StatusDot, TaskAssignees, TaskLabels, WorktreeButton } from './TaskParts';

interface CardProps {
    task: Task;
    selected: boolean;
    isMoving: boolean;
    isDragged: boolean;
    canMove: boolean;
    worktree: string | undefined;
    onSelect(id: string): void;
    onSelectFromKeyboard(id: string): void;
    onOpenWorktree(path: string): void;
    onDragStart(task: Task): void;
    onDragEnd(): void;
    /** Moves the task one column from the keyboard. `step` is -1 for the left column and 1 for the right column. */
    onMoveBy(task: Task, step: -1 | 1): void;
}

/** A task on the board. The user can drag it to another column, or move it with Alt and an arrow key. */
export function BoardCard({
    task,
    selected,
    isMoving,
    isDragged,
    canMove,
    worktree,
    onSelect,
    onSelectFromKeyboard,
    onOpenWorktree,
    onDragStart,
    onDragEnd,
    onMoveBy
}: CardProps) {
    const select = itemKeys(() => onSelectFromKeyboard(task.id));
    return (
        <div
            tabIndex={0}
            role="button"
            aria-label={taskLabel(task)}
            aria-pressed={selected}
            aria-keyshortcuts={canMove ? 'Alt+ArrowLeft Alt+ArrowRight' : undefined}
            data-nav-item
            data-task-id={task.id}
            className={`board-card${selected ? ' selected' : ''}${isMoving ? ' moving' : ''}${isDragged ? ' dragging' : ''}`}
            draggable={canMove && !isMoving}
            title={canMove ? 'Drag to another column to change the status. Or press ⌥← or ⌥→.' : undefined}
            onDragStart={event => {
                event.dataTransfer.setData('text/plain', task.id);
                event.dataTransfer.effectAllowed = 'move';
                onDragStart(task);
            }}
            onDragEnd={onDragEnd}
            onClick={() => onSelect(task.id)}
            onKeyDown={event => {
                if (event.target === event.currentTarget && event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
                    event.preventDefault();
                    onMoveBy(task, event.key === 'ArrowLeft' ? -1 : 1);
                } else {
                    select(event);
                }
            }}
        >
            <div className="board-card-top">
                {task.key && <span className="task-key">{task.key}</span>}
                <span className="header-spacer" />
                {isMoving && <LoaderCircle size={12} className="spin" />}
                {worktree && <WorktreeButton worktree={worktree} onOpenWorktree={onOpenWorktree} />}
            </div>
            <div className="board-card-title">{task.title}</div>
            {(!!task.labels?.length || !!task.assignees?.length) && (
                <div className="board-card-meta">
                    <TaskLabels labels={task.labels} limit={2} />
                    <span className="header-spacer" />
                    <TaskAssignees assignees={task.assignees} />
                </div>
            )}
        </div>
    );
}

interface Props {
    columns: StatusGroup[];
    selectedId: string | undefined;
    /** True when the source can change the status of a task. */
    canMove: boolean;
    /** The tasks that move to another status now. */
    moving: Set<string>;
    isCollapsed(key: string, byDefault: boolean): boolean;
    toggleGroup(key: string, byDefault: boolean): void;
    worktreeFor(task: Task): string | undefined;
    onSelect(id: string): void;
    onSelectFromKeyboard(id: string): void;
    onOpenWorktree(path: string): void;
    /** Moves the task to the status of the column. `fromKeyboard` is true for a move with the keyboard. */
    onMove(task: Task, column: StatusGroup, fromKeyboard: boolean): void;
}

/** The board: a column for each status. The user drags a card to a column to change the status of the task. */
export function TaskBoardColumns({
    columns,
    selectedId,
    canMove,
    moving,
    isCollapsed,
    toggleGroup,
    worktreeFor,
    onSelect,
    onSelectFromKeyboard,
    onOpenWorktree,
    onMove
}: Props) {
    /** The task that the user drags on the board. */
    const [dragging, setDragging] = useState<Task>();
    /** The board column under the dragged card. */
    const [dropTarget, setDropTarget] = useState<string>();

    /**
     * Moves a task to the previous or next board column from the keyboard.
     * It uses the same path as a drop on the column.
     */
    const moveTaskBy = (task: Task, step: -1 | 1) => {
        const column = neighborColumn(columns, task.id, step);
        if (!canMove || !column || moving.has(task.id)) return;
        onMove(task, column, true);
    };

    const renderCard = (task: Task) => (
        <BoardCard
            key={task.id}
            task={task}
            selected={task.id === selectedId}
            isMoving={moving.has(task.id)}
            isDragged={dragging?.id === task.id}
            canMove={canMove}
            worktree={worktreeFor(task)}
            onSelect={onSelect}
            onSelectFromKeyboard={onSelectFromKeyboard}
            onOpenWorktree={onOpenWorktree}
            onDragStart={setDragging}
            onDragEnd={() => {
                setDragging(undefined);
                setDropTarget(undefined);
            }}
            onMoveBy={moveTaskBy}
        />
    );

    return columns.map(column => {
        const key = `board:${column.key}`;
        const byDefault = collapsedByDefault(column.category);
        const closed = isCollapsed(key, byDefault);
        const accepts = acceptsDrop(canMove, dragging, column.key);
        return (
            <section
                key={column.key}
                className={`board-column${closed ? ' collapsed' : ''}${accepts && dropTarget === column.key ? ' drop-target' : ''}`}
                onDragOver={event => {
                    if (accepts) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                        setDropTarget(column.key);
                    }
                }}
                onDragLeave={event => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        setDropTarget(target => (target === column.key ? undefined : target));
                    }
                }}
                onDrop={event => {
                    event.preventDefault();
                    setDropTarget(undefined);
                    if (dragging && accepts) {
                        onMove(dragging, column, false);
                    }
                    setDragging(undefined);
                }}
            >
                <button
                    className="board-column-header"
                    aria-expanded={!closed}
                    title={closed ? `Show ${column.name}` : `Collapse ${column.name}`}
                    onClick={() => toggleGroup(key, byDefault)}
                >
                    <StatusDot status={groupStatus(column)} />
                    <span className="board-column-name">{column.name}</span>
                    <span className="status-group-count">{column.tasks.length}</span>
                </button>
                {!closed && (
                    <div className="board-cards" onKeyDown={moveListFocus}>
                        {column.tasks.map(renderCard)}
                        {column.tasks.length === 0 && <div className="board-empty">{accepts ? 'Drop here' : 'No tasks'}</div>}
                    </div>
                )}
            </section>
        );
    });
}
