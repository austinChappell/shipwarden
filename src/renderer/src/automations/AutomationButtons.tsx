import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, LoaderCircle, Zap } from 'lucide-react';
import { buttonLabel, conditionsAgree, eventVariables, manualAutomationsFor, taskRepo, type Automation, type AutomationEvent } from '@shared/automations';
import { manualPullRequestEvent, manualTaskEvent, manualWorktreeEvent } from '@shared/automation-events';
import type { PullRequest } from '@shared/github';
import type { Task, TaskLink } from '@shared/tasks';
import type { Worktree } from '@shared/worktrees';
import { showContextMenu } from '../components/ContextMenu';
import { Button, IconButton } from '../components/ui';
import { branchSummariesQuery } from '../github/use-branch-status';
import { errorText } from '../util';
import { useAutomationList } from './automation-queries';
import { automationEngine, type EnginePlace } from './engine';

/** The thing that the buttons act on. */
export type ButtonTarget =
    | { entity: 'worktree'; repoPath: string; worktree: Worktree; link?: TaskLink }
    | { entity: 'pullRequest'; repoPath: string; worktree: Worktree; pr: PullRequest; link?: TaskLink }
    | { entity: 'task'; task: Task; connectionId: string; pluginId: string };

interface Props {
    target: ButtonTarget;
    /** "buttons": one button for each automation. "menu": one icon button that opens a menu, for a header with little space. */
    variant?: 'buttons' | 'menu';
    /** Shows the error of a run that did not start. Without it, the buttons show the error. */
    onError?(message: string): void;
}

/** The time that a button shows the check mark after a run started. */
const STARTED_MS = 2500;

/**
 * The buttons of the manual automations of an entity: a worktree, a pull request or a task. A button shows only when
 * the automation is on (or a dry run), and its repository, its branch pattern and its conditions agree with the entity.
 * A click starts a run. The Automations view shows the run and its result.
 */
export function AutomationButtons({ target, variant = 'buttons', onError }: Props) {
    const { list } = useAutomationList();
    const place = placeOf(target);
    const candidates = manualAutomationsFor(list.automations, target.entity, { repoPath: place?.repo, branch: place?.worktree.branch });
    // The worktree buttons give the pull request of the branch. The summaries of a repository load one time each minute already.
    const wantsSummary = target.entity === 'worktree' && candidates.length > 0;
    const summaries = useQuery({ ...branchSummariesQuery(place?.repo ?? ''), enabled: wantsSummary && !!place });
    const [busy, setBusy] = useState<string>();
    const [started, setStarted] = useState<string>();
    const [error, setError] = useState<string>();

    const eventFor = (automation: Automation, at: number): AutomationEvent => {
        switch (target.entity) {
            case 'worktree': {
                const summary = target.worktree.branch ? summaries.data?.[target.worktree.branch] : undefined;
                return manualWorktreeEvent(automation.id, 'manual', { repo: target.repoPath, worktree: target.worktree }, summary, at, target.link);
            }
            case 'pullRequest': {
                const pr = target.pr;
                return manualPullRequestEvent(
                    automation.id,
                    { repo: target.repoPath, worktree: target.worktree },
                    {
                        number: pr.number,
                        title: pr.title,
                        url: pr.url,
                        headSha: pr.headRefOid,
                        isDraft: pr.isDraft,
                        author: pr.author?.login,
                        base: pr.baseRefName,
                        state: pr.state,
                        body: pr.body
                    },
                    at,
                    target.link
                );
            }
            case 'task':
                return manualTaskEvent(
                    automation.id,
                    target.task,
                    target.connectionId,
                    target.pluginId,
                    taskRepo(automation.binding, target.task),
                    at,
                    'manual'
                );
        }
    };

    // The conditions use the same values as the run, so a button shows only when a click can start a run.
    const now = Date.now();
    const shown = candidates.filter(automation => conditionsAgree(automation, eventVariables(eventFor(automation, now))));
    if (shown.length === 0) return null;

    const report = (message: string | undefined) => {
        if (onError) {
            if (message) onError(message);
        } else {
            setError(message);
        }
    };

    const run = async (automation: Automation) => {
        report(undefined);
        setBusy(automation.id);
        try {
            await automationEngine.runNow(automation.id, eventFor(automation, Date.now()), place);
            setStarted(automation.id);
            setTimeout(() => setStarted(current => (current === automation.id ? undefined : current)), STARTED_MS);
        } catch (err) {
            report(errorText(err));
        } finally {
            setBusy(undefined);
        }
    };

    const title = (automation: Automation) =>
        [automation.description, automation.status === 'dry-run' ? 'A dry run: the automation records what it would do, and does nothing.' : '']
            .filter(Boolean)
            .join(' ') || `Run "${automation.name}"`;

    if (variant === 'menu') {
        return (
            <IconButton
                label="Run an automation"
                icon={
                    busy ? (
                        <LoaderCircle size={14} strokeWidth={1.8} className="spin" />
                    ) : started ? (
                        <Check size={14} strokeWidth={1.8} />
                    ) : (
                        <Zap size={14} strokeWidth={1.8} />
                    )
                }
                onClick={async event => {
                    const choice = await showContextMenu(
                        shown.map(automation => ({ id: automation.id, label: buttonLabel(automation), enabled: busy !== automation.id })),
                        event.currentTarget
                    );
                    const automation = shown.find(item => item.id === choice);
                    if (automation) await run(automation);
                }}
            />
        );
    }

    return (
        <div className="automation-buttons">
            {shown.map(automation => (
                <Button
                    key={automation.id}
                    disabled={busy === automation.id}
                    title={title(automation)}
                    icon={
                        busy === automation.id ? (
                            <LoaderCircle size={13} strokeWidth={1.8} className="spin" />
                        ) : started === automation.id ? (
                            <Check size={13} strokeWidth={1.8} />
                        ) : (
                            <Zap size={13} strokeWidth={1.8} />
                        )
                    }
                    onClick={() => void run(automation)}
                >
                    {buttonLabel(automation)}
                </Button>
            ))}
            {error && (
                <button type="button" className="automation-button-error" title="Click to close" onClick={() => setError(undefined)}>
                    {error}
                </button>
            )}
        </div>
    );
}

/** The worktree of the target, for the engine. A task has none. */
function placeOf(target: ButtonTarget): EnginePlace | undefined {
    return target.entity === 'task' ? undefined : { repo: target.repoPath, worktree: target.worktree };
}
