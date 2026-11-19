import { MoreHorizontal } from 'lucide-react';
import { groupsOf, planStepOf, stepPullRequest, stepTaskLink, worktreeOfTask, type ItemAnchor, type PullRequestRef } from '@shared/item-relations';
import type { Plan } from '@shared/plans';
import type { PrGroup } from '@shared/pr-groups';
import type { TaskLink } from '@shared/tasks';
import { useNavigation } from '../app/navigation';
import { useTaskLinks } from '../app/task-links';
import { useBranchStatus } from '../github/use-branch-status';
import { useGroups } from '../github/pr-group-store';
import { usePlans } from '../plans/plan-queries';
import { showContextMenu } from './ContextMenu';
import { IconButton, type ControlSize } from './ui';

/** The items that link to one item. */
export interface RelatedItems {
    worktreePath?: string;
    task?: TaskLink;
    pullRequest?: PullRequestRef;
    plan?: Plan;
    groups: PrGroup[];
}

/** A kind of related item that `RelatedLinks` can show. */
export type RelatedKind = 'worktree' | 'task' | 'pullRequest' | 'plan' | 'group';

/**
 * Finds the items that link to the anchor:
 * - The worktree and the task link to each other by the task links of the worktrees.
 * - The worktree and the pull request link to each other by the branch. The pull request of a worktree comes from the
 *   step of a plan, else from the cached GitHub state of the worktree. That state loads only when `loadPullRequest` is true.
 * - A plan step links its worktree, its task, and its pull request.
 * - A PR group links its pull requests and its plan.
 */
export function useRelatedItems(anchor: ItemAnchor, loadPullRequest = false): RelatedItems {
    const links = useTaskLinks();
    const { plans } = usePlans();
    const { groups } = useGroups();
    const worktreePath = anchor.worktreePath ?? (anchor.task ? worktreeOfTask(links, anchor.task) : undefined);
    // The lists of plans and groups are short. Thus the search runs on each render, with no memo.
    const found = planStepOf(plans, { ...anchor, worktreePath });
    const stepPr = found ? stepPullRequest(found.step) : undefined;
    const known = anchor.pullRequest ?? stepPr;
    const branch = useBranchStatus(worktreePath, loadPullRequest && !known && !!worktreePath);
    const branchPr = branch.status?.pullRequest ? { repo: branch.status.repo, number: branch.status.pullRequest.number } : undefined;
    const pullRequest = known ?? branchPr;
    const task = (worktreePath ? links[worktreePath] : undefined) ?? (found ? stepTaskLink(found.step) : undefined);
    const plan = found?.plan;
    return { worktreePath: worktreePath ?? found?.step.worktreePath, task, pullRequest, plan, groups: groupsOf(groups, pullRequest, plan?.id) };
}

interface Props {
    anchor: ItemAnchor;
    /** The kinds of items in the menu, in this order. */
    show: RelatedKind[];
    size?: ControlSize;
    className?: string;
}

/**
 * A "…" button with a menu that opens the items that link to one item: its worktree, its task, its pull request, its
 * plan, and its PR groups. An item that does not exist has no menu item. Without any item, the button does not show.
 */
export function RelatedLinks({ anchor, show, size = 'md', className }: Props) {
    const nav = useNavigation();
    const items = useRelatedItems(anchor, show.includes('pullRequest'));
    if (!nav) return null;
    const { worktreePath, task, pullRequest, plan, groups } = items;

    const entries = show.flatMap((kind): { id: string; label: string; open(): void }[] => {
        switch (kind) {
            case 'worktree':
                return worktreePath ? [{ id: 'worktree', label: 'Open the worktree', open: () => nav.openWorktree(worktreePath) }] : [];
            case 'task':
                return task ? [{ id: 'task', label: `Open the task ${task.key ?? `"${task.title}"`}`, open: () => nav.openTask(task) }] : [];
            case 'pullRequest':
                return pullRequest ? [{ id: 'pr', label: `Open the pull request #${pullRequest.number}`, open: () => nav.openPullRequest(pullRequest) }] : [];
            case 'plan':
                return plan ? [{ id: 'plan', label: `Open the plan "${plan.title}"`, open: () => nav.openPlan(plan.id) }] : [];
            case 'group':
                return groups.map(group => ({ id: `group-${group.id}`, label: `Open the PR group "${group.name}"`, open: () => nav.openGroup(group.id) }));
        }
    });
    if (entries.length === 0) return null;

    const openMenu = async (anchorElement: Element) => {
        const choice = await showContextMenu(
            entries.map(({ id, label }) => ({ id, label })),
            anchorElement
        );
        entries.find(entry => entry.id === choice)?.open();
    };
    return (
        <IconButton
            size={size}
            className={className}
            icon={<MoreHorizontal size={size === 'lg' ? 16 : 14} strokeWidth={1.7} />}
            label="Linked items"
            onClick={event => void openMenu(event.currentTarget)}
        />
    );
}
