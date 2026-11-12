import { GitBranch, Link2, Play, Unlink } from 'lucide-react';
import type { Task, TaskSource } from '@shared/tasks';
import { AutomationButtons } from '../../automations/AutomationButtons';
import { Select } from '../ui/Select';
import { targetRepo as pickTargetRepo } from './task-view-logic';

interface Props {
    task: Task;
    source: TaskSource;
    busy: boolean;
    /** The worktree of the task, if a worktree works on it. */
    worktree: string | undefined;
    /** The repositories of the project. "Start in worktree" makes the worktree in one of them. */
    repos: string[];
    /** The repository that "Start in worktree" used last in this project. */
    startRepo: string;
    chooseStartRepo(repo: string): void;
    repoLabel(repo: string): string;
    onOpenWorktree(path: string): void;
    onStartTask(task: Task, connectionId: string, pluginId: string, repo: string): Promise<void>;
    /** Shows a menu of the worktrees under `anchor`, and links the chosen worktree to the task. */
    onLinkWorktree(task: Task, connectionId: string, pluginId: string, anchor: Element): Promise<void>;
    /** Removes the task link of a worktree. */
    onUnlinkWorktree(worktreePath: string): Promise<void>;
    /** Runs an action and shows its error in the details. */
    act(action: () => Promise<void>): void;
    runAction(actionId: string, confirmText?: string): void;
}

/**
 * The buttons of the task: "Open worktree" and "Unlink", or "Start in worktree" and "Link worktree", and the actions of
 * the plugin.
 */
export function TaskActions({
    task,
    source,
    busy,
    worktree,
    repos,
    startRepo,
    chooseStartRepo,
    repoLabel,
    onOpenWorktree,
    onStartTask,
    onLinkWorktree,
    onUnlinkWorktree,
    act,
    runAction
}: Props) {
    /** The repository for "Start in worktree": the last one in this project, else the first. */
    const targetRepo = pickTargetRepo(repos, startRepo);
    return (
        <div className="task-start">
            {worktree ? (
                <>
                    <button className="button primary" onClick={() => onOpenWorktree(worktree)}>
                        <GitBranch size={14} strokeWidth={1.8} />
                        Open worktree
                    </button>
                    <button
                        className="button"
                        disabled={busy}
                        title="Remove the link between the task and its worktree"
                        onClick={() => act(() => onUnlinkWorktree(worktree))}
                    >
                        <Unlink size={14} strokeWidth={1.8} />
                        Unlink
                    </button>
                </>
            ) : (
                <>
                    <button
                        className="button primary"
                        disabled={busy || !targetRepo || !source}
                        title={
                            targetRepo ? `Make a worktree in ${repoLabel(targetRepo)} and start an agent on the task` : 'Add a repository to the project first'
                        }
                        onClick={() => source && targetRepo && act(() => onStartTask(task, source.connectionId, source.pluginId, targetRepo))}
                    >
                        <Play size={14} strokeWidth={1.8} />
                        Start in worktree
                    </button>
                    {repos.length > 1 && (
                        <Select
                            className="tasks-select"
                            value={targetRepo}
                            title="The repository of the new worktree"
                            options={repos.map(repo => ({ value: repo, label: repoLabel(repo) }))}
                            onChange={chooseStartRepo}
                        />
                    )}
                    <button
                        className="button"
                        disabled={busy}
                        title="Link the task to a worktree that exists"
                        onClick={event => {
                            const anchor = event.currentTarget;
                            act(() => onLinkWorktree(task, source.connectionId, source.pluginId, anchor));
                        }}
                    >
                        <Link2 size={14} strokeWidth={1.8} />
                        Link worktree
                    </button>
                </>
            )}
            {source.actions.map(action => (
                <button key={action.id} className="button" disabled={busy} onClick={() => runAction(action.id, action.confirm)}>
                    {action.label}
                </button>
            ))}
            <AutomationButtons
                target={{ entity: 'task', task, connectionId: source.connectionId, pluginId: source.pluginId }}
                onError={message =>
                    act(() => {
                        throw new Error(message);
                    })
                }
            />
        </div>
    );
}
