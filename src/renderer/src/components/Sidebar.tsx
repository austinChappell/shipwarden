import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
    Check,
    ChevronDown,
    ChevronRight,
    CircleCheck,
    CircleDot,
    CircleX,
    Clock,
    EyeOff,
    FolderMinus,
    FolderPlus,
    GitGraph,
    GripVertical,
    GitPullRequest,
    GitPullRequestDraft,
    LayoutDashboard,
    NotebookPen,
    Workflow,
    ListTodo,
    Bot,
    Settings2,
    Plus,
    Search,
    Settings,
    X
} from 'lucide-react';
import { AGENT_STATE_LABELS, worktreeAgentState, type AgentState } from '@shared/agents';
import type { BranchSummary } from '@shared/github';
import type { ProjectsState } from '@shared/projects';
import type { RepoColor } from '@shared/settings';
import { RepoIcon, repoColorStyle } from './RepoIcon';
import type { TaskLink } from '@shared/tasks';
import { runsAgent, type TerminalSession } from '@shared/terminal';
import { isHiddenAt, nextSnoozeEnd, snoozeText, sortWorktrees, type HiddenWorktree, type Worktree, type WorktreeSort } from '@shared/worktrees';
import { errorText } from '../util';
import { Logo } from './Logo';
import { confirmDialog } from './ConfirmDialog';
import { NewWorktreeDialog, type NewWorktreeRequest } from './NewWorktreeDialog';
import { moveMenuFocus, useMenuClose } from './use-menu';
import { worktreeLabel } from '@shared/worktrees';
import { useAgentSessions } from '../terminal/agent-state-store';
import { onSidebarFocusRequest, takeSidebarFocusRequest } from '../sidebar-focus';
import { moveIndex, reorderKeyDelta } from './reorder';

/** The selector of the sidebar items. The Up and Down arrow keys move the focus between them. */
const SIDEBAR_ITEM = '[data-sidebar-item]';

/** Opens the context menu of an element from the keyboard. The menu opens under the element. */
function openMenuAt(element: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 24, clientY: rect.bottom }));
}

/**
 * Returns a key handler for a sidebar item that is not a button.
 * Enter and Space run the action. ⇧F10 and the context menu key open the context menu of the item.
 */
function itemKeys(action: () => void) {
    return (event: ReactKeyboardEvent<HTMLElement>) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            action();
        } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
            event.preventDefault();
            openMenuAt(event.currentTarget);
        }
    };
}

/**
 * Moves the focus between the sidebar items. Up and Down move to the previous and next item. Home and End move to the
 * first and last item. Down in the search field moves to the first item under it.
 */
function moveSidebarFocus(event: ReactKeyboardEvent<HTMLElement>): void {
    const target = event.target as HTMLElement;
    const inSearch = target.tagName === 'INPUT';
    if (!(inSearch ? event.key === 'ArrowDown' : target.matches(SIDEBAR_ITEM) && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(SIDEBAR_ITEM)];
    const after = (item: HTMLElement) => !!(target.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING);
    const next =
        event.key === 'Home'
            ? items[0]
            : event.key === 'End'
              ? items.at(-1)
              : event.key === 'ArrowDown'
                ? items.find(after)
                : items.filter(item => item !== target && !after(item)).at(-1);
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
}

interface Props {
    projects: ProjectsState | undefined;
    /** The repositories of the active project, in sidebar order. */
    repos: string[];
    worktreesByRepo: Record<string, Worktree[]>;
    sessions: TerminalSession[];
    selectedPath: string | undefined;
    /** The task of each worktree, by worktree path. */
    links: Record<string, TaskLink>;
    /** The open pull request of each branch, with its CI state, by repository. */
    summaries: Record<string, Record<string, BranchSummary>>;
    tasksActive: boolean;
    onOpenTasks(): void;
    agentsActive: boolean;
    onOpenAgents(): void;
    reviewActive: boolean;
    onOpenReview(): void;
    pipelinesActive: boolean;
    onOpenPipelines(): void;
    notesActive: boolean;
    onOpenNotes(): void;
    dashboardActive: boolean;
    /** The number of items on the Dashboard that need the user. */
    dashboardCount: number;
    onOpenDashboard(): void;
    settingsActive: boolean;
    onOpenSettings(): void;
    /** Opens the settings of one repository. */
    onOpenRepoSettings(repo: string): void;
    /** The repository whose commit graph shows. Undefined when the graph page does not show. */
    graphRepo?: string;
    /** Opens the commit graph of a repository on a full page. */
    onOpenGraph(repo: string): void;
    /** The name of a repository: its name from the repository settings, else its folder name. */
    repoLabel(repo: string): string;
    repoColor(repo: string): RepoColor | undefined;
    onAddRepo(): void;
    onRemoveRepo(repo: string): void;
    onSwitchProject(id: string): void;
    onCreateProject(name: string): Promise<void>;
    onRenameProject(id: string, name: string): Promise<void>;
    onDeleteProject(id: string): Promise<void>;
    onSelect(worktree: Worktree): void;
    /** Creates a worktree from the New worktree dialog. */
    onCreate(repo: string, request: NewWorktreeRequest): Promise<void>;
    /** The display names of worktrees, by path. */
    worktreeNames?: Record<string, string>;
    onRemove(repo: string, worktree: Worktree): void;
    /** The right-click menu of a worktree: open its task, remove it, or remove it and delete its branch. */
    onWorktreeMenu(repo: string, worktree: Worktree): void;
    /** Opens the task of a worktree in the Tasks view. */
    onOpenTask(worktreePath: string): void;
    /** The order of the worktrees in each repository, from Settings › Worktrees. */
    worktreeSort: WorktreeSort;
    /** The hidden and snoozed worktrees, by path. */
    hiddenWorktrees?: Record<string, HiddenWorktree>;
    /** Moves a project to a new position in the project list. */
    onMoveProject(id: string, toIndex: number): void;
    /** Moves a repository of the active project to a new position. */
    onMoveRepo(repo: string, toIndex: number): void;
}

const COLLAPSED_STORAGE_KEY = 'shipwarden.collapsedRepos';

function basename(path: string): string {
    return path.split('/').filter(Boolean).pop() ?? path;
}

function readCollapsed(): Set<string> {
    try {
        const value = JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? '[]');
        return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
    } catch {
        return new Set();
    }
}

/** The agent state of a set of worktrees: the state that needs the user most. */
function agentStateOf(sessions: TerminalSession[], paths: Set<string>): AgentState | undefined {
    return worktreeAgentState(
        sessions
            .filter(session => (session.isAgent || runsAgent(session)) && session.worktreePath && paths.has(session.worktreePath))
            .map(session => session.agentState)
    );
}

/** The place where a dragged item goes: before or after another item. */
interface DropTarget {
    key: string;
    after: boolean;
}

/**
 * Drag and drop to change the order of a list. `onMove` gets the key of the dragged item and its new index.
 * The returned `itemProps` go on each item. `dropClass` gives the class that shows the drop line.
 * The `onKeyDown` handler of each item calls `moveByKey`, so Alt+Up and Alt+Down move the item from the keyboard.
 */
function useReorder(keys: readonly string[], onMove: (key: string, toIndex: number) => void, enabled = true) {
    const [dragged, setDragged] = useState<string>();
    const [target, setTarget] = useState<DropTarget>();

    const end = () => {
        setDragged(undefined);
        setTarget(undefined);
    };

    const itemProps = (key: string) =>
        enabled
            ? {
                  draggable: true,
                  'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown',
                  onDragStart: (event: DragEvent) => {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', key);
                      setDragged(key);
                  },
                  onDragOver: (event: DragEvent<HTMLElement>) => {
                      if (dragged === undefined) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      const box = event.currentTarget.getBoundingClientRect();
                      const after = event.clientY > box.top + box.height / 2;
                      if (target?.key !== key || target.after !== after) setTarget({ key, after });
                  },
                  onDrop: (event: DragEvent) => {
                      event.preventDefault();
                      if (dragged !== undefined && target) {
                          const from = keys.indexOf(dragged);
                          let to = keys.indexOf(target.key) + (target.after ? 1 : 0);
                          if (from < to) to -= 1;
                          if (from !== -1 && from !== to) onMove(dragged, to);
                      }
                      end();
                  },
                  onDragEnd: end
              }
            : {};

    const dropClass = (key: string) => {
        if (dragged === undefined) return '';
        if (dragged === key) return ' dragging';
        return target?.key === key ? (target.after ? ' drop-after' : ' drop-before') : '';
    };

    /** The item that a key moved. It gets the focus again when the list shows the new order. */
    const moved = useRef<{ element: HTMLElement; key: string; to: number } | undefined>(undefined);
    useEffect(() => {
        const item = moved.current;
        if (!item || keys.indexOf(item.key) !== item.to) return;
        moved.current = undefined;
        if (item.element.isConnected && document.activeElement !== item.element) item.element.focus();
        item.element.scrollIntoView({ block: 'nearest' });
    }, [keys]);

    /** Alt+Up and Alt+Down move the item one place. Returns true when the handler used the key. */
    const moveByKey = (event: ReactKeyboardEvent<HTMLElement>, key: string): boolean => {
        const delta = enabled ? reorderKeyDelta(event) : undefined;
        if (delta === undefined) return false;
        event.preventDefault();
        event.stopPropagation();
        const to = moveIndex(keys, key, delta);
        if (to !== undefined) {
            moved.current = { element: event.currentTarget, key, to };
            onMove(key, to);
        }
        return true;
    };

    /** The tooltip text that tells how to change the order. Undefined when the order cannot change. */
    const hint = enabled ? 'Drag, or press ⌥↑ or ⌥↓, to change the order' : undefined;

    return { itemProps, dropClass, moveByKey, hint };
}

/**
 * Returns the current time. The value changes when the next snooze ends, so a snoozed worktree shows again at its
 * end time. A change of `hidden` also reads the time again.
 */
function useNow(hidden: Record<string, HiddenWorktree> | undefined): number {
    const [now, setNow] = useState(Date.now);
    useEffect(() => setNow(Date.now()), [hidden]);
    useEffect(() => {
        const end = nextSnoozeEnd(hidden, now);
        if (end === undefined) return;
        // setTimeout fails with a delay above 2^31 - 1 ms. A longer snooze sets a new timer when this one ends.
        const timer = setTimeout(() => setNow(Date.now()), Math.min(end - now + 50, 2 ** 31 - 1));
        return () => clearTimeout(timer);
    }, [hidden, now]);
    return now;
}

/** The text of a worktree that the sidebar search looks at. */
function worktreeSearchText(worktree: Worktree, props: Props): string {
    const link = props.links[worktree.path];
    return [worktreeLabel(worktree, props.worktreeNames), worktree.branch, basename(worktree.path), link?.key, link?.title]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
}

/** The project name at the top of the sidebar. Its menu switches, creates, renames and deletes projects. */
function ProjectSwitcher(props: Props) {
    const { projects } = props;
    const [open, setOpen] = useState(false);
    /** The inline form in the menu: a new project, or a new name for the active project. */
    const [form, setForm] = useState<'create' | 'rename'>();
    const [name, setName] = useState('');
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const active = projects?.projects.find(project => project.id === projects.activeId);
    const projectIds = useMemo(() => projects?.projects.map(project => project.id) ?? [], [projects]);
    const reorder = useReorder(projectIds, props.onMoveProject, projectIds.length > 1 && !busy);

    const close = () => {
        setOpen(false);
        setForm(undefined);
        setError(undefined);
    };

    const menuItems = () => [...(root.current?.querySelectorAll<HTMLElement>('.project-menu [role="menuitem"]:not(:disabled)') ?? [])];
    useMenuClose(open, root, close);
    // The first item gets the focus, so the arrow keys work at once.
    useEffect(() => {
        if (open) menuItems()[0]?.focus();
    }, [open]);

    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        setError(undefined);
        try {
            await action();
            close();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (form === 'create') {
            run(() => props.onCreateProject(name));
        } else if (form === 'rename' && active) {
            run(() => props.onRenameProject(active.id, name));
        }
    };

    const remove = async () => {
        if (!active) {
            return;
        }
        const repos = active.repos.length;
        if (
            await confirmDialog({
                title: `Delete the project "${active.name}"?`,
                message: `Its ${repos} ${repos === 1 ? 'repository stays' : 'repositories stay'} on disk, and agents continue to run. Only the list goes away.`,
                confirmLabel: 'Delete project',
                danger: true
            })
        ) {
            run(() => props.onDeleteProject(active.id));
        }
    };

    return (
        <div className="project-switcher" ref={root}>
            <button
                data-sidebar-item
                className="project-button"
                aria-haspopup="menu"
                aria-expanded={open}
                title="Switch the project. The project decides the repositories below."
                onClick={() => (open ? close() : setOpen(true))}
            >
                <span className="project-button-name">{active?.name ?? 'Loading…'}</span>
                <ChevronDown className="repo-chevron" size={13} strokeWidth={1.75} />
            </button>
            {open && projects && (
                <div className="project-menu" role="menu" onKeyDown={event => moveMenuFocus(event, menuItems())}>
                    <div className="project-menu-label">Projects</div>
                    {projects.projects.map(project => (
                        <button
                            key={project.id}
                            role="menuitem"
                            className={`project-menu-item${reorder.dropClass(project.id)}`}
                            title={reorder.hint}
                            {...reorder.itemProps(project.id)}
                            onKeyDown={event => reorder.moveByKey(event, project.id)}
                            onClick={() => {
                                close();
                                if (project.id !== projects.activeId) {
                                    props.onSwitchProject(project.id);
                                }
                            }}
                        >
                            <span className="project-menu-check">{project.id === projects.activeId && <Check size={13} strokeWidth={2} />}</span>
                            <span className="project-menu-name">{project.name}</span>
                            <span className="project-menu-count">{project.repos.length}</span>
                            {projects.projects.length > 1 && <GripVertical className="drag-grip" size={12} strokeWidth={1.75} />}
                        </button>
                    ))}
                    <div className="project-menu-separator" />
                    {form ? (
                        <form className="project-menu-form" onSubmit={submit}>
                            <input
                                autoFocus
                                value={name}
                                disabled={busy}
                                placeholder={form === 'create' ? 'Project name' : active?.name}
                                onChange={event => setName(event.target.value)}
                                onKeyDown={event => {
                                    if (event.key === 'Escape') {
                                        event.stopPropagation();
                                        setForm(undefined);
                                        setError(undefined);
                                    }
                                }}
                            />
                            <button type="submit" className="button primary" disabled={busy}>
                                {form === 'create' ? 'Create' : 'Rename'}
                            </button>
                        </form>
                    ) : (
                        <>
                            <button
                                role="menuitem"
                                className="project-menu-item"
                                onClick={() => {
                                    setName('');
                                    setForm('create');
                                }}
                            >
                                <span className="project-menu-check" />
                                New project…
                            </button>
                            <button
                                role="menuitem"
                                className="project-menu-item"
                                onClick={() => {
                                    setName(active?.name ?? '');
                                    setForm('rename');
                                }}
                            >
                                <span className="project-menu-check" />
                                Rename “{active?.name}”…
                            </button>
                            <button
                                role="menuitem"
                                className="project-menu-item danger"
                                disabled={projects.projects.length === 1}
                                title={projects.projects.length === 1 ? 'ShipWarden needs at least one project.' : undefined}
                                onClick={remove}
                            >
                                <span className="project-menu-check" />
                                Delete “{active?.name}”…
                            </button>
                        </>
                    )}
                    {error && <div className="form-error project-menu-error">{error}</div>}
                </div>
            )}
        </div>
    );
}

interface RepoGroupProps {
    repo: string;
    collapsed: boolean;
    onToggle(): void;
    parent: Props;
    /** The worktrees to show, in sidebar order. A search can show fewer than all. */
    worktrees: Worktree[];
    /** The hidden and snoozed worktrees, in sidebar order. They show under "N hidden". A search puts its matches in `worktrees`. */
    hidden: Worktree[];
    /** The time in milliseconds that decides which snoozes are active. */
    now: number;
    /** The number of all worktrees of the repository. */
    total: number;
    /** The drag and drop handlers of the header, and the class that shows the drop line. */
    dragProps: object;
    dropClass: string;
    /** Moves the repository one place for Alt+Up and Alt+Down. Returns true when it used the key. */
    moveByKey(event: ReactKeyboardEvent<HTMLElement>): boolean;
    /** The tooltip text that tells how to change the order. */
    reorderHint?: string;
}

/** One repository: a header that collapses, and its worktrees. */
function RepoGroup({ repo, collapsed, onToggle, parent, worktrees, hidden, now, total, dragProps, dropClass, moveByKey, reorderHint }: RepoGroupProps) {
    const { sessions, selectedPath } = parent;
    const summaries = parent.summaries[repo] ?? {};
    const [creating, setCreating] = useState(false);
    const [showHidden, setShowHidden] = useState(false);
    const shown = [...worktrees, ...hidden];
    // A hidden agent that waits for the user still shows its state on the collapsed header.
    const repoState = collapsed ? agentStateOf(sessions, new Set(shown.map(worktree => worktree.path))) : undefined;
    const hiddenState = hidden.length > 0 && !showHidden ? agentStateOf(sessions, new Set(hidden.map(worktree => worktree.path))) : undefined;
    /** True when the repository is collapsed and contains the selected worktree. */
    const holdsSelection =
        collapsed &&
        !parent.tasksActive &&
        !parent.settingsActive &&
        !parent.agentsActive &&
        !parent.reviewActive &&
        !parent.dashboardActive &&
        !parent.notesActive &&
        !parent.pipelinesActive &&
        shown.some(worktree => worktree.path === selectedPath);
    const color = parent.repoColor(repo);
    const runningInRepo = collapsed && sessions.some(session => runsAgent(session) && shown.some(worktree => worktree.path === session.worktreePath));

    const renderRow = (worktree: Worktree) => {
        const running = sessions.some(session => session.worktreePath === worktree.path && runsAgent(session));
        const link = parent.links[worktree.path];
        const agentState = agentStateOf(sessions, new Set([worktree.path]));
        const dotClass = agentState ?? (running ? 'running' : '');
        const dotTitle = agentState ? AGENT_STATE_LABELS[agentState] : running ? 'Agent is running' : 'No agent';
        const pr = worktree.branch ? summaries[worktree.branch] : undefined;
        const name = worktreeLabel(worktree, parent.worktreeNames);
        const named = !!parent.worktreeNames?.[worktree.path];
        const hiddenEntry = parent.hiddenWorktrees?.[worktree.path];
        const isHidden = isHiddenAt(hiddenEntry, now);
        return (
            <li
                key={worktree.path}
                className={`worktree-row${isHidden ? ' hidden-worktree' : ''}${worktree.path === selectedPath && !parent.tasksActive && !parent.settingsActive && !parent.agentsActive && !parent.reviewActive && !parent.dashboardActive && !parent.notesActive && !parent.pipelinesActive ? ' selected' : ''}`}
                title={worktree.path}
                tabIndex={0}
                role="button"
                data-sidebar-item
                aria-label={name}
                onClick={() => parent.onSelect(worktree)}
                onKeyDown={itemKeys(() => parent.onSelect(worktree))}
                onContextMenu={event => {
                    event.preventDefault();
                    parent.onWorktreeMenu(repo, worktree);
                }}
            >
                <span className={`status-dot ${dotClass}`} title={dotTitle} />
                <div className="worktree-text">
                    <div className="worktree-name">
                        {isHidden &&
                            (hiddenEntry?.until ? (
                                <span className="worktree-hidden-mark" title={`Snoozed ${snoozeText(hiddenEntry.until, now)}`}>
                                    <Clock size={11} strokeWidth={1.9} />
                                </span>
                            ) : (
                                <span className="worktree-hidden-mark" title="Hidden from the sidebar">
                                    <EyeOff size={11} strokeWidth={1.9} />
                                </span>
                            ))}
                        {name}
                    </div>
                    <div className="worktree-detail">
                        {agentState && agentState !== 'idle' && agentState !== 'exited' && (
                            <span className={`agent-state ${agentState}`}>{AGENT_STATE_LABELS[agentState]}</span>
                        )}
                        {isHidden && hiddenEntry?.until && <span className="worktree-snooze">Snoozed {snoozeText(hiddenEntry.until, now)} · </span>}
                        {link ? (
                            <button
                                className="worktree-task"
                                title={`Open the task: ${link.title}`}
                                onClick={event => {
                                    event.stopPropagation();
                                    parent.onOpenTask(worktree.path);
                                }}
                            >
                                {link.key ? `${link.key} · ` : ''}
                                {link.title}
                            </button>
                        ) : named ? (
                            (worktree.branch ?? basename(worktree.path))
                        ) : worktree.isMain ? (
                            'main worktree'
                        ) : (
                            basename(worktree.path)
                        )}
                    </div>
                </div>
                {pr && (
                    <span className="worktree-pr" title={`Pull request #${pr.number}${pr.checks ? ` · checks ${pr.checks.toLowerCase()}` : ''}`}>
                        {pr.isDraft ? <GitPullRequestDraft size={12} strokeWidth={1.8} /> : <GitPullRequest size={12} strokeWidth={1.8} />}
                        {pr.number}
                        {pr.checks === 'SUCCESS' && <CircleCheck size={12} strokeWidth={2} className="ci success" />}
                        {(pr.checks === 'FAILURE' || pr.checks === 'ERROR') && <CircleX size={12} strokeWidth={2} className="ci failure" />}
                        {(pr.checks === 'PENDING' || pr.checks === 'EXPECTED') && <CircleDot size={12} strokeWidth={2} className="ci pending" />}
                    </span>
                )}
                {!worktree.isMain && (
                    <button
                        className="icon-button row-action"
                        title="Remove worktree"
                        onClick={event => {
                            event.stopPropagation();
                            parent.onRemove(repo, worktree);
                        }}
                    >
                        ×
                    </button>
                )}
            </li>
        );
    };

    return (
        <li className={`repo-group${color ? ' colored' : ''}`} style={repoColorStyle(color)}>
            <div
                className={`repo-header${holdsSelection ? ' holds-selection' : ''}${dropClass}`}
                {...dragProps}
                title={[repo, holdsSelection && 'The selected worktree is in this repository.', reorderHint].filter(Boolean).join('\n')}
                tabIndex={0}
                role="button"
                data-sidebar-item
                aria-expanded={!collapsed}
                onClick={onToggle}
                onKeyDown={event => {
                    if (event.target === event.currentTarget && moveByKey(event)) return;
                    // Left collapses the repository and Right expands it, as in a tree.
                    if (event.target === event.currentTarget && ((event.key === 'ArrowLeft' && !collapsed) || (event.key === 'ArrowRight' && collapsed))) {
                        event.preventDefault();
                        onToggle();
                        return;
                    }
                    itemKeys(onToggle)(event);
                }}
            >
                {collapsed ? <ChevronRight size={13} strokeWidth={2} /> : <ChevronDown size={13} strokeWidth={2} />}
                {color && <RepoIcon color={color} size={13} />}
                <span className="repo-header-name">{parent.repoLabel(repo)}</span>
                {collapsed && (repoState || runningInRepo) && (
                    <span
                        className={`status-dot ${repoState ?? 'running'}`}
                        title={repoState ? `An agent in this repository: ${AGENT_STATE_LABELS[repoState]}` : 'An agent runs in this repository'}
                    />
                )}
                {(collapsed || shown.length < total) && <span className="repo-header-count">{shown.length < total ? `${shown.length}/${total}` : total}</span>}
                <button
                    className="icon-button repo-action"
                    title="New worktree"
                    onClick={event => {
                        event.stopPropagation();
                        if (collapsed) {
                            onToggle();
                        }
                        setCreating(true);
                    }}
                >
                    <Plus size={14} strokeWidth={1.75} />
                </button>
                <button
                    className={`icon-button repo-action${parent.graphRepo === repo ? ' on' : ''}`}
                    title="Commit graph"
                    onClick={event => {
                        event.stopPropagation();
                        parent.onOpenGraph(repo);
                    }}
                >
                    <GitGraph size={14} strokeWidth={1.6} />
                </button>
                <button
                    className="icon-button repo-action"
                    title="Repository settings"
                    onClick={event => {
                        event.stopPropagation();
                        parent.onOpenRepoSettings(repo);
                    }}
                >
                    <Settings2 size={14} strokeWidth={1.6} />
                </button>
                <button
                    className="icon-button repo-action"
                    title="Remove from project"
                    onClick={event => {
                        event.stopPropagation();
                        parent.onRemoveRepo(repo);
                    }}
                >
                    <FolderMinus size={14} strokeWidth={1.6} />
                </button>
            </div>

            {creating && (
                <NewWorktreeDialog
                    repoName={parent.repoLabel(repo)}
                    repoPath={repo}
                    onClose={() => setCreating(false)}
                    onCreate={async request => {
                        await parent.onCreate(repo, request);
                        setCreating(false);
                    }}
                />
            )}

            {!collapsed && (
                <ul className="worktree-list">
                    {worktrees.map(renderRow)}
                    {hidden.length > 0 && (
                        <li
                            className="worktree-hidden-toggle"
                            title={showHidden ? 'Collapse the hidden worktrees' : 'Show the hidden and snoozed worktrees'}
                            tabIndex={0}
                            role="button"
                            data-sidebar-item
                            aria-expanded={showHidden}
                            onClick={() => setShowHidden(value => !value)}
                            onKeyDown={itemKeys(() => setShowHidden(value => !value))}
                        >
                            {showHidden ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
                            <EyeOff size={12} strokeWidth={1.75} />
                            <span>{hidden.length} hidden</span>
                            {hiddenState && hiddenState !== 'idle' && hiddenState !== 'exited' && (
                                <span className={`status-dot ${hiddenState}`} title={`A hidden agent: ${AGENT_STATE_LABELS[hiddenState]}`} />
                            )}
                        </li>
                    )}
                    {showHidden && hidden.map(renderRow)}
                </ul>
            )}
        </li>
    );
}

/** The left sidebar: the project, the Tasks view, the repositories of the project with their worktrees, and Settings. */
export function Sidebar(outerProps: Props) {
    // The newest agent states come from their own store, so an agent report renders the sidebar again and not the full app.
    const sessions = useAgentSessions(outerProps.sessions);
    const props: Props = { ...outerProps, sessions };
    const [collapsed, setCollapsed] = useState(readCollapsed);
    const [query, setQuery] = useState('');
    const search = query.trim().toLowerCase();
    const reorder = useReorder(props.repos, props.onMoveRepo, !search && props.repos.length > 1);

    const now = useNow(props.hiddenWorktrees);
    /**
     * The repositories to show, each with its sorted worktrees. A search keeps a repository when its name or one of its
     * worktrees matches. A search also finds hidden worktrees. Without a search, the hidden worktrees go to `hidden`.
     */
    const groups = useMemo(
        () =>
            props.repos.flatMap(repo => {
                const all = sortWorktrees(props.worktreesByRepo[repo] ?? [], props.worktreeSort, props.worktreeNames);
                if (!search) {
                    const isHidden = (worktree: Worktree) => isHiddenAt(props.hiddenWorktrees?.[worktree.path], now);
                    return [{ repo, worktrees: all.filter(worktree => !isHidden(worktree)), hidden: all.filter(isHidden), total: all.length }];
                }
                const repoMatches = `${props.repoLabel(repo)}\n${basename(repo)}`.toLowerCase().includes(search);
                const worktrees = repoMatches ? all : all.filter(worktree => worktreeSearchText(worktree, props).includes(search));
                return repoMatches || worktrees.length > 0 ? [{ repo, worktrees, hidden: [], total: all.length }] : [];
            }),
        [props.repos, props.worktreesByRepo, props.worktreeSort, props.worktreeNames, props.hiddenWorktrees, now, props.links, props.repoLabel, search]
    );
    /** The agents of all projects that still run, and the state that needs the user most. */
    const runningAgents = props.sessions.filter(session => runsAgent(session)).length;
    const agentsState = worktreeAgentState(props.sessions.filter(session => runsAgent(session)).map(session => session.agentState));

    // ⇧⌘B moves the focus to the selected item, else to the first item. A request can come before the sidebar mounts.
    const asideRef = useRef<HTMLElement>(null);
    useEffect(() => {
        const focus = () => {
            const root = asideRef.current;
            if (!root || !takeSidebarFocusRequest()) return;
            const target =
                root.querySelector<HTMLElement>('.worktree-row.selected') ??
                root.querySelector<HTMLElement>('.nav-row.selected') ??
                root.querySelector<HTMLElement>('.repo-header.holds-selection') ??
                root.querySelector<HTMLElement>(SIDEBAR_ITEM);
            target?.focus();
            target?.scrollIntoView({ block: 'nearest' });
        };
        focus();
        return onSidebarFocusRequest(focus);
    }, []);

    const toggle = (repo: string) =>
        setCollapsed(current => {
            const next = new Set(current);
            if (next.has(repo)) {
                next.delete(repo);
            } else {
                next.add(repo);
            }
            try {
                localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...next]));
            } catch {
                // The state stays for this session only.
            }
            return next;
        });

    return (
        <aside className="sidebar" ref={asideRef} aria-label="Sidebar" onKeyDown={moveSidebarFocus}>
            <div className="sidebar-titlebar" />
            <div className="brand">
                <Logo size={26} />
                <span className="brand-name">ShipWarden</span>
            </div>

            <button data-sidebar-item className={`nav-row${props.dashboardActive ? ' selected' : ''}`} onClick={props.onOpenDashboard}>
                <LayoutDashboard size={15} strokeWidth={1.6} />
                <span className="nav-row-label">Dashboard</span>
                {props.dashboardCount > 0 && <span className="nav-row-count attention">{props.dashboardCount}</span>}
            </button>
            <button data-sidebar-item className={`nav-row${props.agentsActive ? ' selected' : ''}`} onClick={props.onOpenAgents}>
                <Bot size={15} strokeWidth={1.6} />
                <span className="nav-row-label">Agents</span>
                {agentsState && <span className={`status-dot ${agentsState}`} title={AGENT_STATE_LABELS[agentsState]} />}
                {runningAgents > 0 && <span className="nav-row-count">{runningAgents}</span>}
            </button>
            {props.repos.length > 0 && (
                <button data-sidebar-item className={`nav-row${props.tasksActive ? ' selected' : ''}`} onClick={props.onOpenTasks}>
                    <ListTodo size={15} strokeWidth={1.6} />
                    <span className="nav-row-label">Tasks</span>
                </button>
            )}

            <button data-sidebar-item className={`nav-row${props.reviewActive ? ' selected' : ''}`} onClick={props.onOpenReview}>
                <GitPullRequest size={15} strokeWidth={1.6} />
                <span className="nav-row-label">Review</span>
            </button>
            <button data-sidebar-item className={`nav-row${props.pipelinesActive ? ' selected' : ''}`} onClick={props.onOpenPipelines}>
                <Workflow size={15} strokeWidth={1.6} />
                <span className="nav-row-label">Pipelines</span>
            </button>
            <button data-sidebar-item className={`nav-row${props.notesActive ? ' selected' : ''}`} onClick={props.onOpenNotes}>
                <NotebookPen size={15} strokeWidth={1.6} />
                <span className="nav-row-label">Notes</span>
            </button>

            {/* Only the repositories change with the project, so the project switcher is their header. */}
            <div className="project-header">
                <ProjectSwitcher {...props} />
                <button className="icon-button" title="Add a repository to this project" onClick={props.onAddRepo}>
                    <FolderPlus size={14} strokeWidth={1.6} />
                </button>
            </div>

            {props.repos.length > 0 && (
                <div className="sidebar-search">
                    <Search size={13} strokeWidth={1.75} />
                    <input
                        value={query}
                        placeholder="Search repositories and worktrees"
                        spellCheck={false}
                        onChange={event => setQuery(event.target.value)}
                        onKeyDown={event => {
                            if (event.key === 'Escape') {
                                setQuery('');
                                event.currentTarget.blur();
                            }
                        }}
                    />
                    {query && (
                        <button className="icon-button" title="Clear the search" onClick={() => setQuery('')}>
                            <X size={12} strokeWidth={2} />
                        </button>
                    )}
                </div>
            )}

            <ul className="repo-list">
                {groups.map(({ repo, worktrees, hidden, total }) => (
                    <RepoGroup
                        key={repo}
                        repo={repo}
                        // A search shows the matches, also in a collapsed repository.
                        collapsed={!search && collapsed.has(repo)}
                        onToggle={() => toggle(repo)}
                        parent={props}
                        worktrees={worktrees}
                        hidden={hidden}
                        now={now}
                        total={total}
                        dragProps={reorder.itemProps(repo)}
                        dropClass={reorder.dropClass(repo)}
                        moveByKey={event => reorder.moveByKey(event, repo)}
                        reorderHint={reorder.hint}
                    />
                ))}
                {search && groups.length === 0 && <li className="repo-empty repo-no-match">No repositories or worktrees match “{query.trim()}”.</li>}
                {props.projects && props.repos.length === 0 && (
                    <li className="repo-empty">
                        <button className="button" onClick={props.onAddRepo}>
                            Add a repository
                        </button>
                    </li>
                )}
            </ul>

            <div className="sidebar-footer">
                <button data-sidebar-item className={`nav-row${props.settingsActive ? ' selected' : ''}`} title="Settings (⌘,)" onClick={props.onOpenSettings}>
                    <Settings size={15} strokeWidth={1.6} />
                    <span>Settings</span>
                </button>
            </div>
        </aside>
    );
}
