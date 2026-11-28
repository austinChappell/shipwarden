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
    /**
     * The repositories of all projects, in the order of the sidebar. "Start in worktree" makes the worktree in one of them.
     * The user must select the repository for each task. When all projects have one repository, the buttons use it.
     */
    repoGroups: RepoGroup[];
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
    repoGroups,
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
    // The choice is for this task only. TaskDetails makes a new TaskActions for each task.
    const [chosenRepo, setChosenRepo] = useState<string>();
    const targetRepo = pickTargetRepo(repoGroups, chosenRepo);
    const repoCount = repoGroups.reduce((count, group) => count + group.repos.length, 0);
    const noRepoText = repoCount === 0 ? 'Add a repository to the project first' : 'Select a repository first';
    // Without a repository, a click on a start button opens the repository menu. The choice then runs the button.
    const [pending, setPending] = useState<PendingAction>();
    const [askRepo, setAskRepo] = useState(0);
    /** Runs an action in a repository. */
    const run = (action: PendingAction, repo: string) => {
        if (action === 'start') act(() => onStartTask(task, source.connectionId, source.pluginId, repo));
        else if (action === 'queue')
            act(() => queueTask({ connectionId: source.connectionId, pluginId: source.pluginId, task, repoPath: repo }).then(() => undefined));
        else setComparing(true);
    };
    /** Runs the action in the target repository. Without one, asks for the repository first. */
    const request = (action: PendingAction) => {
        if (targetRepo) {
            run(action, targetRepo);
            return;
        }
        setPending(action);
        setAskRepo(count => count + 1);
    };
    const chooseRepo = (repo: string) => {
        setChosenRepo(repo);
        // The menu calls onClose before onChange, but this render still holds the pending action.
        if (pending) run(pending, repo);
    };
    /** The tooltip of a start button when no repository is selected. */
    const chooseText = repoCount === 0 ? noRepoText : 'Select a repository for the new worktree';
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
                        disabled={busy || repoCount === 0}
                        title={targetRepo ? `Make a worktree in ${repoLabel(targetRepo)} and start an agent on the task` : chooseText}
                        onClick={() => request('start')}
                    >
                        Start in worktree
                    </Button>
                    <Button
                        icon={<ListPlus size={14} strokeWidth={1.8} />}
                        disabled={busy || repoCount === 0 || !!queued}
                        title={queueButtonTitle(
                            queued && queuePosition(queue, queued.id),
                            !!queued,
                            targetRepo ? repoLabel(targetRepo) : undefined,
                            chooseText
                        )}
                        onClick={() => request('queue')}
                    >
                        {queued ? 'In queue' : 'Add to queue'}
                    </Button>
                    {compare && (
                        <Button
                            icon={<GitCompareArrows size={14} strokeWidth={1.8} />}
                            disabled={busy || repoCount === 0}
                            title={targetRepo ? 'Give the task to 2 to 4 agents, each in its own worktree, and keep the best result' : chooseText}
                            onClick={() => request('compare')}
                        >
                            Compare agents
                        </Button>
                    )}
                    {repoCount > 1 && (
                        <Combobox
                            value={targetRepo}
                            title="The repository of the new worktree"
                            aria-label="Repository of the new worktree"
                            placeholder="Select a repository"
                            searchPlaceholder={pending ? 'Select the repository for the new worktree' : 'Search repositories'}
                            groups={repoGroups
                                .filter(group => group.repos.length > 0)
                                .map(group => ({ label: group.name, items: group.repos.map(repo => ({ value: repo, label: repoLabel(repo) })) }))}
                            openRequest={askRepo}
                            onClose={() => setPending(undefined)}
                            onChange={chooseRepo}
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

/** A start button that waits for the user to select a repository. */
type PendingAction = 'start' | 'queue' | 'compare';

/** The tooltip of "Add to queue". `position` is the place of a queued task, from 1. A task that starts or runs has none. */
function queueButtonTitle(position: number | undefined, inQueue: boolean, repo: string | undefined, noRepoText: string): string {
    if (position) return `The task is number ${position} in the queue`;
    if (inQueue) return 'An agent of the queue works on the task now';
    if (!repo) return noRepoText;
    return `Start the task later, when the queue has a free place. The worktree goes in ${repo}.`;
}
