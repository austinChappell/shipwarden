import type { BranchDetails, LocalBranch, RemoteBranch } from '@shared/branches';
import type { Plan, PlanStep } from '@shared/plans';
import type { TaskLink } from '@shared/tasks';

/** The filter chips of the local branches. */
export type BranchFilter = 'all' | 'worktree' | 'diverged' | 'localOnly' | 'remoteDeleted' | 'old';

/** How the list groups the branches. */
export type BranchGrouping = 'prefix' | 'none';

/** A branch is "old" when its last commit is older than this time. */
export const OLD_BRANCH_MS = 7 * 24 * 3_600_000;

/** One row of the branch table. A row is a local branch or a remote branch. */
export interface BranchRow {
    /** The full name: "feature/login" for a local branch, "origin/feature/login" for a remote branch. */
    name: string;
    /** The name in the row: the name without the prefix of its group, and without the step number. */
    label: string;
    /** The number of the plan step of the branch. */
    step?: number;
    /** The ticket of the branch, for example "ENG-12207". */
    ticket?: string;
    date: number;
    subject: string;
    local?: LocalBranch;
    remote?: RemoteBranch;
}

/** A group of rows with the same prefix, for example all the branches of one plan. */
export interface BranchGroup {
    /** The prefix, for example "plan/demo-o9se/". "" is the group of the other branches. */
    key: string;
    /** "plan": the branches of a plan. "prefix": a folder of branches. "other": the branches without a group. "all": no grouping. */
    kind: 'plan' | 'prefix' | 'other' | 'all';
    rows: BranchRow[];
    /** The newest commit date in the group. */
    newest: number;
    /** The number of local branches whose remote branch does not exist now. */
    gone: number;
    /** The number of plan steps of the group whose pull request merged. */
    merged: number;
}

/** The plan step of a branch, with the number of the step in its plan. */
export interface StepOfBranch {
    step: PlanStep;
    number: number;
}

/** Returns the plan step of each branch of the plans. */
export function stepsByBranch(plans: readonly Plan[]): Map<string, StepOfBranch> {
    const map = new Map<string, StepOfBranch>();
    for (const plan of plans) {
        plan.steps.forEach((step, index) => {
            if (step.branch) map.set(step.branch, { step, number: index + 1 });
        });
    }
    return map;
}

/** Returns the task link of each branch that a worktree with a task link has checked out. */
export function linksByBranch(details: BranchDetails, links: Readonly<Record<string, TaskLink>>): Map<string, TaskLink> {
    const map = new Map<string, TaskLink>();
    for (const branch of details.local) {
        const link = branch.worktree ? links[branch.worktree] : undefined;
        if (link) map.set(branch.name, link);
    }
    return map;
}

/** A ticket key in uppercase in a commit subject, for example "ENG-12207". */
const SUBJECT_TICKET = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;
/** A ticket key in any case at the start of a commit subject, for example "eng-11328 — process the uploads". */
const LEADING_TICKET = /^\[?([a-z][a-z0-9]{1,9}-\d+)\]?(?=$|[\s:—–-])/i;
/** A ticket key in a branch name, with 3 or more digits, for example "eng-12207" in "story/eng-12207-login". */
const NAME_TICKET = /(?:^|[/_-])([a-z][a-z0-9]{1,9}-\d{3,})(?=$|[/_-])/i;

/**
 * Returns the ticket of a branch. The order is: the task of its plan step, the task link of its worktree, a key in
 * the branch name, then a key in the last commit subject.
 */
export function ticketOf(name: string, subject: string, link?: TaskLink, step?: PlanStep): string | undefined {
    const stepLink = step?.task.kind === 'existing' ? step.task.link : undefined;
    const fromLink = stepLink?.key ?? link?.key;
    if (fromLink) return fromLink;
    const inName = NAME_TICKET.exec(name)?.[1];
    if (inName) return inName.toUpperCase();
    const subjectText = commitParts(subject).text;
    return LEADING_TICKET.exec(subjectText)?.[1].toUpperCase() ?? SUBJECT_TICKET.exec(subject)?.[1];
}

/**
 * Removes the ticket from the start of a commit text, with the separator after it, for example "ENG-12207 — call the
 * API" becomes "call the API". The Ticket column shows the ticket, so the text does not repeat it.
 */
export function withoutTicket(text: string, ticket: string | undefined): string {
    if (!ticket) return text;
    const match = LEADING_TICKET.exec(text);
    if (!match || match[1].toUpperCase() !== ticket.toUpperCase()) return text;
    const rest = text.slice(match[0].length).replace(/^\s*[:—–-]?\s*/, '');
    return rest || text;
}

/** The type of a commit and the rest of its subject, for example "fix" and "upgrade papaparse". */
export interface CommitParts {
    type?: string;
    text: string;
}

/**
 * Splits a commit subject into its type and its text. It reads a Conventional Commits subject, for example
 * "fix(api): upgrade papaparse", and the merge commits of git and GitHub. Other subjects have no type.
 */
export function commitParts(subject: string): CommitParts {
    const pull = /^Merge pull request #(\d+) from (\S+)/.exec(subject);
    if (pull) return { type: 'merge', text: `PR #${pull[1]} · ${pull[2]}` };
    const merge = /^Merge (?:remote-tracking )?branch '([^']+)'(.*)$/.exec(subject);
    if (merge) return { type: 'merge', text: `${merge[1]}${merge[2]}`.trim() };
    const conventional = /^([a-z]{2,12})(?:\([^)]*\))?!?:\s+(.+)$/.exec(subject);
    if (conventional) return { type: conventional[1], text: conventional[2] };
    return { text: subject };
}

/** True when a local branch passes a filter chip. `now` is the current time in milliseconds. */
export function passesFilter(branch: LocalBranch, filter: BranchFilter, mainWorktree: string, now: number): boolean {
    switch (filter) {
        case 'worktree':
            return !!branch.worktree && branch.worktree !== mainWorktree;
        case 'diverged':
            return !!branch.ahead || !!branch.behind;
        case 'localOnly':
            return !branch.upstream;
        case 'remoteDeleted':
            return !!branch.gone;
        case 'old':
            return now - branch.date > OLD_BRANCH_MS;
        default:
            return true;
    }
}

/** True when the filter text is in the name, the ticket, or the commit subject of a row. `needle` is in lowercase. */
export function matchesText(row: BranchRow, needle: string): boolean {
    if (!needle) return true;
    return [row.name, row.ticket ?? '', row.subject].some(text => text.toLowerCase().includes(needle));
}

/** The prefix of a branch name: all the folders before the last "/", with the "/". "" when the name has no folder. */
export function prefixOf(name: string): string {
    const slash = name.lastIndexOf('/');
    return slash < 0 ? '' : name.slice(0, slash + 1);
}

/**
 * Puts the rows into groups by prefix. A group with only one row goes into the "other" group, so the list has no
 * groups of one. The groups with the newest commit come first, and the "other" group is last. In a plan group, the
 * rows are in the order of the steps. `nameOf` gives the name to group by, for example the name without the remote.
 */
export function groupRows(
    rows: readonly BranchRow[],
    grouping: BranchGrouping,
    steps: ReadonlyMap<string, StepOfBranch>,
    nameOf = (row: BranchRow) => row.name
): BranchGroup[] {
    const summary = (key: string, kind: BranchGroup['kind'], items: BranchRow[]): BranchGroup => ({
        key,
        kind,
        rows: items,
        newest: Math.max(0, ...items.map(row => row.date)),
        gone: items.filter(row => row.local?.gone).length,
        merged: items.filter(row => row.local && steps.get(row.local.name)?.step.mergedAt).length
    });
    if (grouping === 'none') return rows.length > 0 ? [summary('', 'all', [...rows])] : [];

    const byPrefix = new Map<string, BranchRow[]>();
    for (const row of rows) {
        const prefix = prefixOf(nameOf(row));
        byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), row]);
    }
    const groups: BranchGroup[] = [];
    const other: BranchRow[] = [];
    for (const [prefix, items] of byPrefix) {
        if (!prefix || items.length < 2) {
            other.push(...items.map(row => ({ ...row, label: nameOf(row) })));
            continue;
        }
        const plan = prefix.startsWith('plan/');
        const labelled = items.map(row => {
            const rest = nameOf(row).slice(prefix.length);
            const numbered = plan ? /^(\d+)-(.+)$/.exec(rest) : null;
            const step = row.step ?? (numbered ? Number(numbered[1]) : undefined);
            return { ...row, label: numbered ? numbered[2] : rest, ...(step !== undefined ? { step } : {}) };
        });
        if (plan) labelled.sort((a, b) => (a.step ?? Number.MAX_SAFE_INTEGER) - (b.step ?? Number.MAX_SAFE_INTEGER));
        groups.push(summary(prefix, plan ? 'plan' : 'prefix', labelled));
    }
    groups.sort((a, b) => b.newest - a.newest);
    if (other.length > 0) {
        other.sort((a, b) => b.date - a.date);
        groups.push(summary('', 'other', other));
    }
    return groups;
}
