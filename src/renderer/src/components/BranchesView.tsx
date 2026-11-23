import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Circle, CircleDot, FolderGit2, GitBranch, GitGraph, LoaderCircle, Trash2 } from 'lucide-react';
import { localDeleteBlock, remoteDeleteBlock, withoutLocal, withoutRemote, type BranchDetails, type LocalBranch, type RemoteBranch } from '@shared/branches';
import type { Worktree } from '@shared/worktrees';
import { pluralize } from '@shared/format';
import { useTaskLinks } from '../app/task-links';
import { gitChanged } from '../git/git-store';
import { fetchBranches, setBranchDetails, updateBranchDetails, useBranchDetails } from '../git/branch-queries';
import {
    commitParts,
    groupRows,
    linksByBranch,
    matchesText,
    passesFilter,
    stepsByBranch,
    ticketOf,
    type BranchFilter,
    type BranchGroup,
    type BranchGrouping,
    type BranchRow,
    withoutTicket
} from '../git/branch-list';
import { moveListFocus } from '../keyboard/list-nav';
import { usePlans } from '../plans/plan-queries';
import { errorText } from '../util';
import { confirmDialog } from './ConfirmDialog';
import { EmptyState } from './EmptyState';
import type { GraphWorktreeStart } from './GitGraphView';
import { radioGroupKeys } from './keyboard';
import { showToast } from './Toast';
import { Age, Button, ButtonGroup, Chip, FilterField, IconButton, PageHeader, RefreshButton, Select, SkeletonRows } from './ui';

type BranchScope = 'local' | 'remote';

const SCOPE_STORAGE_KEY = 'shipwarden.branchScope';
const GROUPING_STORAGE_KEY = 'shipwarden.branchGrouping';
/** The number of branch names that a confirm dialog lists. The dialog gives the count of the other branches. */
const LISTED_NAMES = 20;
/** A commit of the last day shows its age in strong text, so the new work is easy to see. */
const FRESH_MS = 24 * 3_600_000;

const FILTERS: { value: BranchFilter; label: string; title: string }[] = [
    { value: 'all', label: 'All', title: 'Show all local branches' },
    { value: 'worktree', label: 'Has worktree', title: 'Show the branches that a worktree has checked out' },
    { value: 'diverged', label: 'Diverged', title: 'Show the branches that are ahead of or behind their remote branch' },
    { value: 'localOnly', label: 'Local only', title: 'Show the branches that do not track a remote branch' },
    { value: 'remoteDeleted', label: 'Remote deleted', title: 'Show the branches whose remote branch does not exist now' },
    { value: 'old', label: 'Older than 7d', title: 'Show the branches with no commit in the last 7 days' }
];

const GROUPINGS = [
    { value: 'prefix', label: 'Group by plan / prefix' },
    { value: 'none', label: 'No groups' }
] as const;

interface Props {
    /** The path of the repository: its main worktree. */
    repo: string;
    repoName: string;
    /** The worktrees of the repository. A branch that a worktree has checked out opens that worktree. */
    worktrees: Worktree[];
    onNewWorktree(start: GraphWorktreeStart): void;
    onOpenWorktree(worktree: Worktree): void;
    onOpenGraph(): void;
    /** Runs after a checkout or a pull, because the branch of a worktree changed. */
    onWorktreesChanged(): void;
}

function readStored<T extends string>(key: string, values: readonly T[], fallback: T): T {
    try {
        const value = localStorage.getItem(key);
        return values.includes(value as T) ? (value as T) : fallback;
    } catch {
        return fallback;
    }
}

function store(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // The choice stays for this session only.
    }
}

/** The names of the branches for a confirm dialog, one on each line. After LISTED_NAMES names, one line gives the count of the others. */
function nameList(names: readonly string[]): string {
    const shown = names.slice(0, LISTED_NAMES);
    const more = names.length - shown.length;
    return [...shown, ...(more > 0 ? [`and ${pluralize(more, 'other branch', 'other branches')}`] : [])].join('\n');
}

const isoDate = (ms: number) => new Date(ms).toISOString();

/** The ahead and behind counts of a local branch, for example "↑3 ↓2". Empty when both are 0. */
function aheadBehind(branch: LocalBranch): string {
    return [branch.ahead ? `↑${branch.ahead}` : '', branch.behind ? `↓${branch.behind}` : ''].filter(Boolean).join(' ');
}

/** The Remote column of a local branch: the ahead and behind counts, "remote deleted", or "local only". */
function UpstreamCell({ branch }: { branch: LocalBranch }) {
    if (branch.gone) {
        return (
            <Chip tone="warning" title={`The remote branch ${branch.upstream} does not exist now. Its pull request probably merged.`}>
                remote deleted
            </Chip>
        );
    }
    if (!branch.upstream) return <Chip title="This branch does not track a remote branch.">local only</Chip>;
    const counts = aheadBehind(branch);
    if (!counts) return null;
    return (
        <span className="br-track mono" title={`Compared with ${branch.upstream}: ${branch.ahead ?? 0} ahead, ${branch.behind ?? 0} behind.`}>
            {counts}
        </span>
    );
}

/**
 * The Last commit column: the commit type as a small tag, then the subject. The tag column has one width, so the
 * subjects line up. A ticket at the start of the subject is not repeated, because the Ticket column shows it.
 */
function CommitCell({ subject, ticket }: { subject: string; ticket?: string }) {
    const parts = commitParts(subject);
    return (
        <span className="br-commit" title={subject}>
            <span className="br-type mono">{parts.type}</span>
            <span className="br-subject">{withoutTicket(parts.text, ticket)}</span>
        </span>
    );
}

/**
 * The local and remote branches of a repository on a full page, in a table that groups the branches by plan and by
 * prefix. The user can check out, pull, and delete branches, open the worktree of a branch, and delete many local
 * branches in one step.
 */
export function BranchesView({ repo, repoName, worktrees, onNewWorktree, onOpenWorktree, onOpenGraph, onWorktreesChanged }: Props) {
    const query = useBranchDetails(repo);
    const details = query.data;
    const { plans } = usePlans();
    const taskLinks = useTaskLinks();
    const [scope, setScope] = useState<BranchScope>(() => readStored(SCOPE_STORAGE_KEY, ['local', 'remote'], 'local'));
    const [grouping, setGrouping] = useState<BranchGrouping>(() => readStored(GROUPING_STORAGE_KEY, ['prefix', 'none'], 'prefix'));
    const [filter, setFilter] = useState<BranchFilter>('all');
    const [text, setText] = useState('');
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
    const [fetching, setFetching] = useState(false);
    /** The action that runs now. The other actions wait, because git locks the repository. */
    const [busy, setBusy] = useState<string>();
    const [error, setError] = useState<string>();

    const worktreeByPath = useMemo(() => new Map(worktrees.map(item => [item.path, item])), [worktrees]);
    const steps = useMemo(() => stepsByBranch(plans), [plans]);
    const links = useMemo(() => (details ? linksByBranch(details, taskLinks) : new Map()), [details, taskLinks]);
    const needle = text.trim().toLowerCase();
    const singleRemote = new Set(details?.remote.map(branch => branch.remote)).size <= 1;
    const defaultBranch = details?.local.find(branch => branch.name === details.defaultBranch);

    /** The rows of the scope after the filter chip and the filter text. The default branch has its own card. */
    const rows = useMemo<BranchRow[]>(() => {
        if (!details) return [];
        const now = Date.now();
        const all: BranchRow[] =
            scope === 'local'
                ? details.local
                      .filter(branch => branch.name !== details.defaultBranch && passesFilter(branch, filter, details.mainWorktree, now))
                      .map(branch => {
                          const step = steps.get(branch.name);
                          return {
                              name: branch.name,
                              label: branch.name,
                              date: branch.date,
                              subject: branch.subject,
                              local: branch,
                              ...(step ? { step: step.number } : {}),
                              ticket: ticketOf(branch.name, branch.subject, links.get(branch.name), step?.step)
                          };
                      })
                : details.remote.map(branch => ({
                      name: branch.name,
                      label: branch.name,
                      date: branch.date,
                      subject: branch.subject,
                      remote: branch,
                      ticket: ticketOf(branch.branch, branch.subject, undefined, steps.get(branch.branch)?.step)
                  }));
        return all.filter(row => matchesText(row, needle));
    }, [details, scope, filter, needle, steps, links]);

    const groups = useMemo(
        () => groupRows(rows, grouping, steps, row => (row.remote && singleRemote ? row.remote.branch : row.name)),
        [rows, grouping, steps, singleRemote]
    );
    /** The local branches that "Delete" in the header deletes: the shown rows that git can delete. */
    const deletable = useMemo(
        () => (details && scope === 'local' ? rows.filter(row => row.local && !localDeleteBlock(row.local, details)) : []),
        [details, scope, rows]
    );
    const goneCount = details?.local.filter(branch => branch.gone).length ?? 0;

    const changeScope = (next: BranchScope) => {
        setScope(next);
        store(SCOPE_STORAGE_KEY, next);
    };

    const changeGrouping = (next: BranchGrouping) => {
        setGrouping(next);
        store(GROUPING_STORAGE_KEY, next);
    };

    const toggleGroup = (key: string) =>
        setCollapsed(current => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    /** Runs one action. The action has the busy state while it runs. An error shows above the list. */
    const run = async (key: string, action: () => Promise<void>) => {
        if (busy) return;
        setBusy(key);
        setError(undefined);
        try {
            await action();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(undefined);
        }
    };

    const refresh = async () => {
        setFetching(true);
        setError(undefined);
        try {
            const result = await fetchBranches(repo);
            if (result.fetchError) setError(`The fetch failed. The list shows the branches before the fetch. ${result.fetchError}`);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setFetching(false);
        }
    };

    /** Writes a new branch list from a checkout or a pull into the cache, and tells the other views. */
    const applyChange = (next: BranchDetails) => {
        setBranchDetails(repo, next);
        gitChanged();
        onWorktreesChanged();
    };

    const checkout = (name: string, kind: 'local' | 'remote') =>
        run(`checkout:${kind}:${name}`, async () => applyChange(await window.shipwarden.worktrees.checkoutBranch(repo, name, kind)));

    const pull = (name: string) => run(`pull:${name}`, async () => applyChange(await window.shipwarden.worktrees.pullBranch(repo, name)));

    /** Deletes local branches. A branch that is not merged stays until the user agrees to force the delete. */
    const deleteLocal = async (names: string[]) => {
        const api = window.shipwarden.worktrees;
        const first = await api.deleteBranches(repo, names);
        let deleted = first.deleted;
        let failed = first.failed;
        if (first.notMerged.length > 0) {
            const one = first.notMerged.length === 1;
            const agreed = await confirmDialog({
                title: one
                    ? `The branch "${first.notMerged[0]}" has commits that are not merged into the default branch.`
                    : `${pluralize(first.notMerged.length, 'branch', 'branches')} have commits that are not merged into the default branch.`,
                message: `Delete ${one ? 'the branch' : 'these branches'} anyway? The commits are then lost, unless the remote branch has them.`,
                detail: one ? undefined : nameList(first.notMerged),
                confirmLabel: one ? 'Delete branch' : 'Delete branches',
                danger: true
            });
            if (agreed) {
                const forced = await api.deleteBranches(repo, first.notMerged, true);
                deleted = [...deleted, ...forced.deleted];
                failed = [...failed, ...forced.failed];
            }
        }
        if (deleted.length > 0) {
            updateBranchDetails(repo, current => withoutLocal(current, deleted));
            gitChanged();
        }
        if (failed.length > 0) {
            setError(failed.map(item => `${item.branch}: ${item.error}`).join('\n'));
        } else if (names.length > 1 && deleted.length > 0) {
            showToast(`Deleted ${pluralize(deleted.length, 'local branch', 'local branches')}.`);
        }
    };

    const deleteShown = async () => {
        const names = deletable.map(row => row.name);
        const agreed = await confirmDialog({
            title: `Delete ${pluralize(names.length, 'local branch', 'local branches')}?`,
            message:
                'ShipWarden keeps the default branch and the branches that a worktree has checked out. The remote branches stay. ' +
                'Before it deletes a branch with commits that are not merged, ShipWarden asks again.',
            detail: nameList(names),
            confirmLabel: 'Delete branches',
            danger: true
        });
        if (agreed) await run('bulk', () => deleteLocal(names));
    };

    const deleteRemote = async (branch: RemoteBranch) => {
        const agreed = await confirmDialog({
            title: `Delete the branch "${branch.branch}" on ${branch.remote}?`,
            message: 'The branch goes away for all people who use this remote. An open pull request of the branch closes.',
            confirmLabel: 'Delete remote branch',
            danger: true
        });
        if (!agreed) return;
        await run(`delete:remote:${branch.name}`, async () => {
            await window.shipwarden.worktrees.deleteRemoteBranch(repo, branch.name);
            updateBranchDetails(repo, current => withoutRemote(current, branch.name));
            gitChanged();
        });
    };

    const spinner = (key: string, size = 12) => (busy === key ? <LoaderCircle size={size} className="spin" /> : undefined);
    const trash = (key: string) => spinner(key, 14) ?? <Trash2 size={14} strokeWidth={1.7} />;

    /**
     * The icon at the start of a row: a folder for a worktree, a dot for the main folder, else a small circle. A remote
     * branch shows the icon of the local branch that tracks it.
     */
    const rowIcon = (row: BranchRow, all: BranchDetails): ReactNode => {
        const local = row.local ?? (row.remote ? all.local.find(item => item.upstream === row.remote?.name) : undefined);
        const path = local?.worktree;
        if (path && path === all.mainWorktree) {
            return <CircleDot size={14} strokeWidth={1.8} className="br-icon main" aria-label="Checked out in the main folder" />;
        }
        if (path) return <FolderGit2 size={14} strokeWidth={1.7} className="br-icon tree" aria-label="Has a worktree" />;
        return <Circle size={7} strokeWidth={2} className="br-icon none" aria-label="No worktree" />;
    };

    const localActions = (branch: LocalBranch, all: BranchDetails) => {
        const block = localDeleteBlock(branch, all);
        const worktree = branch.worktree && branch.worktree !== all.mainWorktree ? worktreeByPath.get(branch.worktree) : undefined;
        const deleteKey = `delete:local:${branch.name}`;
        return (
            <>
                {worktree && (
                    <Button size="md" disabled={!!busy} onClick={() => onOpenWorktree(worktree)}>
                        Open
                    </Button>
                )}
                {!branch.worktree && (
                    <Button
                        size="md"
                        disabled={!!busy}
                        icon={spinner(`checkout:local:${branch.name}`)}
                        title="Check out this branch in the main folder of the repository"
                        onClick={() => void checkout(branch.name, 'local')}
                    >
                        Check out
                    </Button>
                )}
                <IconButton
                    size="md"
                    tone="danger"
                    disabled={!!busy || !!block}
                    icon={trash(deleteKey)}
                    label={block ?? `Delete ${branch.name}`}
                    onClick={() => void run(deleteKey, () => deleteLocal([branch.name]))}
                />
            </>
        );
    };

    const remoteActions = (branch: RemoteBranch, all: BranchDetails) => {
        const block = remoteDeleteBlock(branch, all.defaultBranch);
        const tracked = all.local.find(item => item.upstream === branch.name);
        return (
            <>
                <IconButton
                    size="md"
                    disabled={!!busy}
                    icon={<FolderGit2 size={14} strokeWidth={1.7} />}
                    label={`Check out ${branch.name} in a new worktree`}
                    onClick={() => onNewWorktree({ remote: branch.name })}
                />
                <Button
                    size="md"
                    disabled={!!busy || !!tracked?.worktree}
                    icon={spinner(`checkout:remote:${branch.name}`)}
                    title={
                        tracked?.worktree ? `The branch ${tracked.name} is checked out already.` : 'Check out this branch in the main folder of the repository'
                    }
                    onClick={() => void checkout(branch.name, 'remote')}
                >
                    Check out
                </Button>
                <IconButton
                    size="md"
                    tone="danger"
                    disabled={!!busy || !!block}
                    icon={trash(`delete:remote:${branch.name}`)}
                    label={block ?? `Delete ${branch.branch} on ${branch.remote}`}
                    onClick={() => void deleteRemote(branch)}
                />
            </>
        );
    };

    /**
     * The Local column of a remote branch: the local branch that tracks it, with its ahead and behind counts. A local
     * branch with the same name shows as "local". A local branch with a different name shows its name.
     */
    const trackedCell = (branch: RemoteBranch, all: BranchDetails) => {
        const tracked = all.local.find(item => item.upstream === branch.name);
        if (!tracked) return null;
        const counts = aheadBehind(tracked);
        return (
            <span className="br-tracked" title={`The local branch ${tracked.name} tracks this branch.`}>
                <Chip mono={tracked.name !== branch.branch}>{tracked.name === branch.branch ? 'local' : tracked.name}</Chip>
                {counts && <span className="br-track mono">{counts}</span>}
            </span>
        );
    };

    const renderRow = (row: BranchRow, group: BranchGroup, all: BranchDetails) => {
        const fresh = Date.now() - row.date < FRESH_MS;
        const rowBusy = !!busy && busy.endsWith(`:${row.name}`);
        return (
            <div
                key={row.name}
                className={`br-row${rowBusy ? ' busy' : ''}${group.kind === 'plan' ? ' stepped' : ''}`}
                tabIndex={0}
                role="row"
                aria-label={row.name}
                data-nav-item
            >
                <span className="br-cell-icon" role="cell">
                    {rowIcon(row, all)}
                </span>
                <span className="br-cell-name" role="cell" title={row.name}>
                    {group.kind === 'plan' && <span className="br-step mono">{row.step ?? ''}</span>}
                    <span className="br-name mono">{row.label}</span>
                    {row.name === all.defaultBranch && <Chip tone="info">default</Chip>}
                </span>
                <span className="br-cell-ticket mono" role="cell">
                    {row.ticket}
                </span>
                <span className="br-cell-commit" role="cell">
                    <CommitCell subject={row.subject} ticket={row.ticket} />
                </span>
                <span className="br-cell-remote" role="cell">
                    {row.local ? <UpstreamCell branch={row.local} /> : row.remote ? trackedCell(row.remote, all) : null}
                </span>
                <span className="br-cell-age" role="cell">
                    <Age className={fresh ? 'br-fresh' : undefined} date={isoDate(row.date)} plain />
                </span>
                <span className="br-cell-actions" role="cell">
                    {row.local ? localActions(row.local, all) : row.remote ? remoteActions(row.remote, all) : null}
                </span>
            </div>
        );
    };

    const groupMeta = (group: BranchGroup) =>
        [pluralize(group.rows.length, 'branch', 'branches'), group.merged > 0 ? `${group.merged} merged` : ''].filter(Boolean).join(' · ');

    const renderGroup = (group: BranchGroup, all: BranchDetails) => {
        if (group.kind === 'all') return group.rows.map(row => renderRow(row, group, all));
        const key = group.key || 'other';
        const open = !collapsed.has(key);
        const Chevron = open ? ChevronDown : ChevronRight;
        return (
            <div key={key} className="br-group" role="rowgroup">
                <button type="button" className="br-group-head" aria-expanded={open} onClick={() => toggleGroup(key)}>
                    <Chevron size={14} strokeWidth={1.8} aria-hidden="true" />
                    <span className="br-group-name mono">{group.key || 'Other'}</span>
                    <Chip>{group.kind === 'other' ? 'ungrouped' : group.kind}</Chip>
                    <span className="br-group-meta">{groupMeta(group)}</span>
                    <span className="br-group-space" />
                    {group.gone > 0 && <span className="br-group-meta warning">{group.gone} remote deleted</span>}
                </button>
                {open && group.rows.map(row => renderRow(row, group, all))}
            </div>
        );
    };

    const total = scope === 'local' ? details?.local.length : details?.remote.length;
    const nounOf = (count: number) => pluralize(count, `${scope} branch`, `${scope} branches`);
    const filtered = needle || (scope === 'local' && filter !== 'all');
    const shownCount = rows.length + (scope === 'local' && defaultBranch && !filtered ? 1 : 0);

    return (
        <div className="branches-view">
            <PageHeader
                icon={GitBranch}
                title={repoName}
                meta={total === undefined ? undefined : filtered ? `${shownCount} of ${nounOf(total)}` : nounOf(total)}
                scope={
                    <ButtonGroup role="radiogroup" size="lg" label="Branches to show" onKeyDown={radioGroupKeys}>
                        {(['local', 'remote'] as const).map(value => (
                            <Button key={value} role="radio" aria-checked={scope === value} onClick={() => changeScope(value)}>
                                {value === 'local' ? 'Local' : 'Remote'}
                            </Button>
                        ))}
                    </ButtonGroup>
                }
                filter={<FilterField value={text} onChange={setText} placeholder="Filter branches" label="Filter by name, ticket, or message" />}
                actions={
                    <>
                        {scope === 'local' && (
                            <Button
                                size="lg"
                                variant="danger"
                                disabled={!!busy || deletable.length === 0}
                                icon={spinner('bulk')}
                                title="Delete the shown local branches, except the default branch and the branches that are checked out"
                                onClick={() => void deleteShown()}
                            >
                                {filtered ? `Delete ${deletable.length}` : 'Delete all'}
                            </Button>
                        )}
                        <IconButton size="lg" icon={<GitGraph size={16} strokeWidth={1.7} />} label="Commit graph" onClick={onOpenGraph} />
                        <RefreshButton size="lg" refreshing={fetching || query.isFetching} onRefresh={() => void refresh()} />
                    </>
                }
            />
            <div className="br-body">
                <div className="br-toolbar">
                    {scope === 'local' ? (
                        <div className="br-filters" role="group" aria-label="Show only">
                            {FILTERS.map(item => (
                                <button
                                    key={item.value}
                                    type="button"
                                    className={`br-filter${item.value === 'remoteDeleted' && goneCount > 0 ? ' warning' : ''}`}
                                    aria-pressed={filter === item.value}
                                    title={item.title}
                                    onClick={() => setFilter(item.value)}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <span className="br-toolbar-label">The remote branches that the last fetch found. Refresh to fetch again.</span>
                    )}
                    <span className="br-group-space" />
                    <Select value={grouping} options={GROUPINGS} onChange={changeGrouping} aria-label="Group the branches" size="md" />
                </div>

                {(error || query.error) && <div className="form-error br-error">{error ?? errorText(query.error)}</div>}
                {!details && !query.error && <SkeletonRows count={8} label="Loading the branches" />}

                {details && scope === 'local' && defaultBranch && (
                    <div className="br-default">
                        <GitBranch size={16} strokeWidth={1.8} aria-hidden="true" className="br-default-icon" />
                        <span className="br-name mono">{defaultBranch.name}</span>
                        <Chip tone="info">{defaultBranch.worktree === details.mainWorktree ? 'default · checked out' : 'default'}</Chip>
                        {defaultBranch.behind ? (
                            <span className="br-track mono">
                                ↓{defaultBranch.behind} behind {defaultBranch.upstream?.split('/')[0]}
                            </span>
                        ) : null}
                        {defaultBranch.ahead ? <span className="br-track mono">↑{defaultBranch.ahead} ahead</span> : null}
                        <CommitCell subject={defaultBranch.subject} />
                        <Age className="br-default-age" date={isoDate(defaultBranch.date)} plain />
                        {defaultBranch.behind ? (
                            <Button
                                size="md"
                                variant="accent"
                                disabled={!!busy}
                                icon={spinner(`pull:${defaultBranch.name}`)}
                                title={`Fetch ${defaultBranch.upstream} and fast-forward ${defaultBranch.name}`}
                                onClick={() => void pull(defaultBranch.name)}
                            >
                                Pull
                            </Button>
                        ) : null}
                    </div>
                )}

                {details && scope === 'local' && goneCount > 0 && filter !== 'remoteDeleted' && (
                    <div className="br-notice">
                        <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
                        <span>
                            {goneCount === 1
                                ? '1 branch has no remote branch now. Its pull request probably merged.'
                                : `${goneCount} branches have no remote branch now. Their pull requests probably merged.`}
                        </span>
                        <span className="br-group-space" />
                        <Button size="md" onClick={() => setFilter('remoteDeleted')}>
                            Review and clean up
                        </Button>
                    </div>
                )}

                {details && groups.length === 0 && (
                    <EmptyState icon={GitBranch} title={filtered ? 'No branches match' : scope === 'local' ? 'No other local branches' : 'No remote branches'}>
                        {filtered
                            ? 'No branch passes the filter. Select "All" or clear the filter text.'
                            : scope === 'local'
                              ? 'The repository has only the default branch.'
                              : 'The repository has no remote branches. Refresh to fetch the remotes.'}
                    </EmptyState>
                )}

                {details && groups.length > 0 && (
                    <div className="br-table" role="table" aria-label={`${scope === 'local' ? 'Local' : 'Remote'} branches`} onKeyDown={moveListFocus}>
                        <div className="br-row br-head" role="row">
                            <span className="br-cell-icon" />
                            <span className="br-cell-name" role="columnheader">
                                Branch
                            </span>
                            <span className="br-cell-ticket" role="columnheader">
                                Ticket
                            </span>
                            <span className="br-cell-commit" role="columnheader">
                                Last commit
                            </span>
                            <span className="br-cell-remote" role="columnheader">
                                {scope === 'local' ? 'Remote' : 'Local'}
                            </span>
                            <span className="br-cell-age" role="columnheader">
                                Age
                            </span>
                            <span className="br-cell-actions" />
                        </div>
                        {groups.map(group => renderGroup(group, details))}
                    </div>
                )}
            </div>
        </div>
    );
}
