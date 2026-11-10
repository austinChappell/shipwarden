import { GitBranch, Play } from 'lucide-react';
import type { Task, TaskSource } from '@shared/tasks';
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
    /** Runs an action and shows its error in the details. */
    act(action: () => Promise<void>): void;
    runAction(actionId: string, confirmText?: string): void;
}

/** The buttons of the task: "Open worktree" or "Start in worktree", and the actions of the plugin. */
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
    act,
    runAction
}: Props) {
    /** The repository for "Start in worktree": the last one in this project, else the first. */
    const targetRepo = pickTargetRepo(repos, startRepo);
    return (
        <div className="task-start">
            {worktree ? (
                <button className="button primary" onClick={() => onOpenWorktree(worktree)}>
                    <GitBranch size={14} strokeWidth={1.8} />
                    Open worktree
                </button>
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
                        <select
                            className="tasks-select"
                            value={targetRepo}
                            title="The repository of the new worktree"
                            onChange={event => chooseStartRepo(event.target.value)}
                        >
                            {repos.map(repo => (
                                <option key={repo} value={repo}>
                                    {repoLabel(repo)}
                                </option>
                            ))}
                        </select>
                    )}
                </>
            )}
            {source.actions.map(action => (
                <button key={action.id} className="button" disabled={busy} onClick={() => runAction(action.id, action.confirm)}>
                    {action.label}
                </button>
            ))}
        </div>
    );
}
