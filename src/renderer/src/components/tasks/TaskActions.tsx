import { useState } from 'react';
import { GitBranch, GitCompareArrows, Link2, ListPlus, Play, Unlink } from 'lucide-react';
import type { Task, TaskSource } from '@shared/tasks';
import { AutomationButtons } from '../../automations/AutomationButtons';
import { Button, Combobox } from '../ui';
import { targetRepo as pickTargetRepo, type RepoGroup } from './task-view-logic';
import { CompareAgentsDialog } from '../compare/CompareAgentsDialog';
import { RelatedLinks } from '../RelatedLinks';
import type { CompareProps } from '../compare/CompareRuns';
import { openItemOfTask, queuePosition } from '@shared/task-queue';
import { queueTask, useTaskQueue } from '../../queue/queue-queries';

interface Props {
    task: Task;
    source: TaskSource;
    busy: boolean;
    /** The worktree of the task, if a worktree works on it. */
    worktree: string | undefined;
    /** The repositories of the active project. "Start in worktree" uses the first one when the user chose none. */
    repos: string[];
    /** The repositories of all projects, in the order of the sidebar. "Start in worktree" makes the worktree in one of them. */
    repoGroups: RepoGroup[];
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
    /** The agent comparisons. Without it, "Compare agents" does not show. */
    compare?: CompareProps;
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
    repoGroups,
    startRepo,
    chooseStartRepo,
    repoLabel,
    onOpenWorktree,
    onStartTask,
    onLinkWorktree,
    onUnlinkWorktree,
    act,
    runAction,
    compare
}: Props) {
    const [comparing, setComparing] = useState(false);
    const { state: queue } = useTaskQueue();
    const queued = openItemOfTask(queue, source.connectionId, task.id);
    const targetRepo = pickTargetRepo(repoGroups, repos, startRepo);
    const repoCount = repoGroups.reduce((count, group) => count + group.repos.length, 0);
    return (
        <div className="task-start">
            {worktree ? (
                <>
                    <Button variant="primary" icon={<GitBranch size={14} strokeWidth={1.8} />} onClick={() => onOpenWorktree(worktree)}>
                        Open worktree
                    </Button>
                    <Button
                        icon={<Unlink size={14} strokeWidth={1.8} />}
                        disabled={busy}
                        title="Remove the link between the task and its worktree"
                        onClick={() => act(() => onUnlinkWorktree(worktree))}
                    >
                        Unlink
                    </Button>
                </>
            ) : (
                <>
                    <Button
                        variant="primary"
                        icon={<Play size={14} strokeWidth={1.8} />}
                        disabled={busy || !targetRepo || !source}
                        title={
                            targetRepo ? `Make a worktree in ${repoLabel(targetRepo)} and start an agent on the task` : 'Add a repository to the project first'
                        }
                        onClick={() => source && targetRepo && act(() => onStartTask(task, source.connectionId, source.pluginId, targetRepo))}
                    >
                        Start in worktree
                    </Button>
                    <Button
                        icon={<ListPlus size={14} strokeWidth={1.8} />}
                        disabled={busy || !targetRepo || !source || !!queued}
                        title={queueButtonTitle(queued && queuePosition(queue, queued.id), !!queued, targetRepo ? repoLabel(targetRepo) : undefined)}
                        onClick={() =>
                            source &&
                            targetRepo &&
                            act(async () => {
                                await queueTask({ connectionId: source.connectionId, pluginId: source.pluginId, task, repoPath: targetRepo });
                            })
                        }
                    >
                        {queued ? 'In queue' : 'Add to queue'}
                    </Button>
                    {compare && (
                        <Button
                            icon={<GitCompareArrows size={14} strokeWidth={1.8} />}
                            disabled={busy || !targetRepo || !source}
                            title="Give the task to 2 to 4 agents, each in its own worktree, and keep the best result"
                            onClick={() => setComparing(true)}
                        >
                            Compare agents
                        </Button>
                    )}
                    {repoCount > 1 && (
                        <Combobox
                            value={targetRepo}
                            title="The repository of the new worktree"
                            aria-label="Repository of the new worktree"
                            placeholder="Repository"
                            searchPlaceholder="Search repositories"
                            groups={repoGroups
                                .filter(group => group.repos.length > 0)
                                .map(group => ({ label: group.name, items: group.repos.map(repo => ({ value: repo, label: repoLabel(repo) })) }))}
                            onChange={chooseStartRepo}
                        />
                    )}
                    <Button
                        icon={<Link2 size={14} strokeWidth={1.8} />}
                        disabled={busy}
                        title="Link the task to a worktree that exists"
                        onClick={event => {
                            const anchor = event.currentTarget;
                            act(() => onLinkWorktree(task, source.connectionId, source.pluginId, anchor));
                        }}
                    >
                        Link worktree
                    </Button>
                </>
            )}
            {source.actions.map(action => (
                <Button key={action.id} disabled={busy} onClick={() => runAction(action.id, action.confirm)}>
                    {action.label}
                </Button>
            ))}
            <RelatedLinks
                anchor={{ worktreePath: worktree, task: { connectionId: source.connectionId, id: task.id, url: task.url } }}
                show={['pullRequest', 'plan', 'group']}
            />
            {comparing && compare && targetRepo && (
                <CompareAgentsDialog
                    agents={compare.agents}
                    repoName={repoLabel(targetRepo)}
                    onClose={() => setComparing(false)}
                    onStart={agentIds => compare.start(task, source.connectionId, source.pluginId, targetRepo, agentIds)}
                />
            )}
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

/** The tooltip of "Add to queue". `position` is the place of a queued task, from 1. A task that starts or runs has none. */
function queueButtonTitle(position: number | undefined, inQueue: boolean, repo: string | undefined): string {
    if (position) return `The task is number ${position} in the queue`;
    if (inQueue) return 'An agent of the queue works on the task now';
    if (!repo) return 'Add a repository to the project first';
    return `Start the task later, when the queue has a free place. The worktree goes in ${repo}.`;
}
