import type { RepoScript, RepoSettings } from '@shared/settings';
import {
    isHiddenAt,
    pruneHiddenWorktrees,
    SNOOZE_LABELS,
    type HiddenWorktree,
    type RemoveWorktreeResult,
    type SnoozeOption,
    type Worktree,
    worktreeLabel
} from '@shared/worktrees';
import type { Project } from '@shared/projects';
import type { TaskLink } from '@shared/tasks';
import type { ContextMenuItem } from '../components/ContextMenu';

/** Returns the message of an error, without the prefix that Electron adds to an IPC error. */
export function errorText(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** Returns the display names of the worktrees with a new name for one worktree. An empty name removes the entry. */
export function withWorktreeName(names: Record<string, string> | undefined, path: string, name: string | undefined): Record<string, string> {
    const next = { ...(names ?? {}) };
    if (name) next[path] = name;
    else delete next[path];
    return next;
}

/**
 * Returns the hidden worktrees with a change for one worktree. `undefined` shows the worktree again.
 * The result does not have the snoozes that ended before `now`.
 */
export function withHiddenWorktree(
    hidden: Record<string, HiddenWorktree> | undefined,
    path: string,
    value: HiddenWorktree | undefined,
    now: number
): Record<string, HiddenWorktree> {
    const next = { ...(pruneHiddenWorktrees(hidden, now) ?? {}) };
    if (value) next[path] = value;
    else delete next[path];
    return next;
}

/** Returns the repository settings with new scripts for one repository. An empty entry goes out of the map. */
export function withRepoScripts(repos: Record<string, RepoSettings>, repoPath: string, scripts: RepoScript[]): Record<string, RepoSettings> {
    const { scripts: _old, ...rest } = repos[repoPath] ?? {};
    const entry = scripts.length > 0 ? { ...rest, scripts } : rest;
    const next = { ...repos };
    if (Object.keys(entry).length > 0) next[repoPath] = entry;
    else delete next[repoPath];
    return next;
}

/** True when two repositories are the same, on the same host. The compare ignores the case of the letters. */
export { sameRepoRef } from '@shared/github';

/** The text of the dialog that asks the user to agree to the removal of a worktree. */
export function removeWorktreeDialog(name: string, branch: string | undefined, hasTeardown: boolean): { title: string; message: string; confirmLabel: string } {
    const teardown = hasTeardown ? ' The teardown script of the repository runs first.' : '';
    const branchText = branch
        ? `ShipWarden then pulls the newest changes of the branch that the worktree started from, and git deletes the local branch "${branch}". The remote branch stays.`
        : 'Git keeps the branch.';
    return {
        title: `Remove the worktree "${name}"?`,
        message: `${branchText} Uncommitted changes stop the removal. The terminals, editors and running processes of this worktree stop.${teardown}`,
        confirmLabel: branch ? 'Remove and delete branch' : 'Remove worktree'
    };
}

/** The title and the last 15 output lines of a teardown script that failed. */
export function teardownFailure(failure: NonNullable<RemoveWorktreeResult['teardownFailed']>): { title: string; tail: string } {
    const reason = failure.timedOut ? 'did not finish in 5 minutes' : `failed with exit code ${failure.code}`;
    return { title: `The teardown script ${reason}.`, tail: failure.output.split('\n').slice(-15).join('\n') };
}

/** Returns the items of the context menu of a worktree in the sidebar. `shells` is the number of open shell tabs of the worktree. */
export function worktreeMenuItems(
    worktree: Worktree,
    taskKey: string | undefined,
    hasTask: boolean,
    hidden: HiddenWorktree | undefined,
    now: number,
    shells = 0
): ContextMenuItem[] {
    const snoozeOptions = Object.keys(SNOOZE_LABELS) as SnoozeOption[];
    return [
        ...(hasTask
            ? [
                  { id: 'task', label: `Open Task${taskKey ? ` ${taskKey}` : ''}` },
                  { id: 'linkTask', label: 'Change Linked Task…' },
                  { id: 'unlinkTask', label: 'Unlink Task' }
              ]
            : [{ id: 'linkTask', label: 'Link to Task…' }]),
        { type: 'separator' as const },
        { id: 'rename', label: 'Rename…' },
        { id: 'closeShells', label: shells > 0 ? `Close ${shells} ${shells === 1 ? 'Shell' : 'Shells'}…` : 'Close Shells', enabled: shells > 0 },
        { type: 'separator' as const },
        ...(isHiddenAt(hidden, now)
            ? [{ id: 'show', label: hidden?.until ? 'Stop Snooze' : 'Show in Sidebar' }]
            : [
                  { id: 'hide', label: 'Hide from Sidebar' },
                  { label: 'Snooze', submenu: snoozeOptions.map(option => ({ id: `snooze:${option}`, label: SNOOZE_LABELS[option] })) }
              ]),
        { type: 'separator' as const },
        { id: 'remove', label: 'Remove Worktree…', enabled: !worktree.isMain, danger: true },
        {
            id: 'removeBranch',
            label: worktree.branch ? `Remove Worktree and Delete Branch "${worktree.branch}"…` : 'Remove Worktree and Delete Branch…',
            enabled: !worktree.isMain && !!worktree.branch,
            danger: true
        }
    ];
}

/** Returns the snooze option of a menu choice such as "snooze:hour". Returns undefined for other choices. */
export function snoozeChoice(choice: string | undefined): SnoozeOption | undefined {
    const option = choice?.startsWith('snooze:') ? choice.slice('snooze:'.length) : undefined;
    return option && option in SNOOZE_LABELS ? (option as SnoozeOption) : undefined;
}

/** The prefix of the menu choices of `linkWorktreeMenuItems`. The worktree path comes after it. */
const LINK_PREFIX = 'link:';

/**
 * Returns the items of the menu that links a task to a worktree, in three levels: project › repository › worktree.
 * The active project comes first. Repositories and projects without worktrees are not in the menu. A worktree with
 * another task shows the key of that task.
 */
export function linkWorktreeMenuItems(
    projects: readonly Pick<Project, 'id' | 'name' | 'repos'>[],
    activeId: string | undefined,
    worktreesByRepo: Record<string, Worktree[]>,
    names: Record<string, string> | undefined,
    links: Record<string, TaskLink>,
    repoLabel: (repo: string) => string
): ContextMenuItem[] {
    const worktreeItems = (repo: string): ContextMenuItem[] =>
        (worktreesByRepo[repo] ?? []).map(worktree => {
            const other = links[worktree.path];
            const name = worktreeLabel(worktree, names);
            return { id: `${LINK_PREFIX}${worktree.path}`, label: other ? `${name} (${other.key ?? other.title})` : name };
        });
    const ordered = [...projects.filter(project => project.id === activeId), ...projects.filter(project => project.id !== activeId)];
    const items = ordered
        .map(project => ({
            label: project.name,
            submenu: project.repos
                .filter(repo => (worktreesByRepo[repo] ?? []).length > 0)
                .map(repo => ({ label: repoLabel(repo), submenu: worktreeItems(repo) }))
        }))
        .filter(project => project.submenu.length > 0);
    return items.length > 0 ? items : [{ id: 'none', label: 'No project has worktrees', enabled: false }];
}

/** Returns the worktree path of a choice of `linkWorktreeMenuItems`. Returns undefined for other choices. */
export function linkWorktreeChoice(choice: string | undefined): string | undefined {
    return choice?.startsWith(LINK_PREFIX) ? choice.slice(LINK_PREFIX.length) : undefined;
}
