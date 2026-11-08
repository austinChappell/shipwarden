import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
    Check,
    ChevronDown,
    ChevronRight,
    CircleCheck,
    CircleDot,
    CircleX,
    FolderMinus,
    FolderPlus,
    GitPullRequest,
    GitPullRequestDraft,
    LayoutDashboard,
    NotebookPen,
    Workflow,
    ListTodo,
    Bot,
    Settings2,
    Plus,
    Settings
} from 'lucide-react';
import { AGENT_STATE_LABELS, worktreeAgentState, type AgentState } from '@shared/agents';
import type { BranchSummary } from '@shared/github';
import type { ProjectsState } from '@shared/projects';
import { REPO_COLORS, type RepoColor } from '@shared/settings';
import type { TaskLink } from '@shared/tasks';
import type { TerminalSession } from '@shared/terminal';
import type { Worktree } from '@shared/worktrees';
import { errorText } from '../util';
import { Logo } from './Logo';
import { confirmDialog } from './ConfirmDialog';

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
    onCreate(repo: string, branch: string): Promise<void>;
    onRemove(repo: string, worktree: Worktree): void;
    /** The right-click menu of a worktree: open its task, remove it, or remove it and delete its branch. */
    onWorktreeMenu(repo: string, worktree: Worktree): void;
    /** Opens the task of a worktree in the Tasks view. */
    onOpenTask(worktreePath: string): void;
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
    return worktreeAgentState(sessions.filter(session => session.isAgent && session.worktreePath && paths.has(session.worktreePath)).map(session => session.agentState));
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

    const close = () => {
        setOpen(false);
        setForm(undefined);
        setError(undefined);
    };

    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointer = (event: PointerEvent) => {
            if (!root.current?.contains(event.target as Node)) {
                close();
            }
        };
        const onKey = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') {
                close();
            }
        };
        window.addEventListener('pointerdown', onPointer);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('pointerdown', onPointer);
            window.removeEventListener('keydown', onKey);
        };
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
        if (await confirmDialog({
            title: `Delete the project "${active.name}"?`,
            message: `Its ${repos} ${repos === 1 ? 'repository stays' : 'repositories stay'} on disk, and agents continue to run. Only the list goes away.`,
            confirmLabel: 'Delete project',
            danger: true
        })) {
            run(() => props.onDeleteProject(active.id));
        }
    };

    return (
        <div className="project-switcher" ref={root}>
            <button className="project-button" title="Switch the project. The project decides the repositories below." onClick={() => (open ? close() : setOpen(true))}>
                <span className="project-button-name">{active?.name ?? 'Loading…'}</span>
                <ChevronDown className="repo-chevron" size={13} strokeWidth={1.75} />
            </button>
            {open && projects && (
                <div className="project-menu" role="menu">
                    <div className="project-menu-label">Projects</div>
                    {projects.projects.map(project => (
                        <button
                            key={project.id}
                            role="menuitem"
                            className="project-menu-item"
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
                            <button type="submit" className="button primary" disabled={busy}>{form === 'create' ? 'Create' : 'Rename'}</button>
                        </form>
                    ) : (
                        <>
                            <button role="menuitem" className="project-menu-item" onClick={() => { setName(''); setForm('create'); }}>
                                <span className="project-menu-check" />New project…
                            </button>
                            <button role="menuitem" className="project-menu-item" onClick={() => { setName(active?.name ?? ''); setForm('rename'); }}>
                                <span className="project-menu-check" />Rename “{active?.name}”…
                            </button>
                            <button
                                role="menuitem"
                                className="project-menu-item danger"
                                disabled={projects.projects.length === 1}
                                title={projects.projects.length === 1 ? 'ShipWarden needs at least one project.' : undefined}
                                onClick={remove}
                            >
                                <span className="project-menu-check" />Delete “{active?.name}”…
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
}

/** One repository: a header that collapses, and its worktrees. */
function RepoGroup({ repo, collapsed, onToggle, parent }: RepoGroupProps) {
    const { sessions, selectedPath } = parent;
    const worktrees = parent.worktreesByRepo[repo] ?? [];
    const summaries = parent.summaries[repo] ?? {};
    const [creating, setCreating] = useState(false);
    const [branch, setBranch] = useState('');
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const repoState = collapsed ? agentStateOf(sessions, new Set(worktrees.map(worktree => worktree.path))) : undefined;
    /** True when the repository is collapsed and contains the selected worktree. */
    const holdsSelection = collapsed && !parent.tasksActive && !parent.settingsActive && !parent.agentsActive && !parent.reviewActive && !parent.dashboardActive && !parent.notesActive && !parent.pipelinesActive && worktrees.some(worktree => worktree.path === selectedPath);
    const runningInRepo = collapsed && sessions.some(session => session.isAgent && !session.exited && worktrees.some(worktree => worktree.path === session.worktreePath));

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        const name = branch.trim();
        if (!name || busy) {
            return;
        }
        if (/\s/.test(name)) {
            setError('A branch name cannot contain spaces.');
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            await parent.onCreate(repo, name);
            setBranch('');
            setCreating(false);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Escape') {
            setCreating(false);
            setBranch('');
            setError(undefined);
        }
    };

    return (
        <li className="repo-group">
            <div
                className={`repo-header${holdsSelection ? ' holds-selection' : ''}`}
                title={holdsSelection ? `${repo}\nThe selected worktree is in this repository.` : repo}
                onClick={onToggle}
            >
                {collapsed ? <ChevronRight size={13} strokeWidth={2} /> : <ChevronDown size={13} strokeWidth={2} />}
                {parent.repoColor(repo) && <span className="repo-color" style={{ background: REPO_COLORS[parent.repoColor(repo)!] }} />}
                <span className="repo-header-name">{parent.repoLabel(repo)}</span>
                {collapsed && (repoState || runningInRepo) && (
                    <span
                        className={`status-dot ${repoState ?? 'running'}`}
                        title={repoState ? `An agent in this repository: ${AGENT_STATE_LABELS[repoState]}` : 'An agent runs in this repository'}
                    />
                )}
                {collapsed && <span className="repo-header-count">{worktrees.length}</span>}
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

            {creating && !collapsed && (
                <form className="new-worktree" onSubmit={submit}>
                    <input
                        autoFocus
                        value={branch}
                        placeholder="branch-name"
                        disabled={busy}
                        onChange={event => setBranch(event.target.value)}
                        onKeyDown={onKeyDown}
                    />
                    {error && <div className="form-error">{error}</div>}
                </form>
            )}

            {!collapsed && (
                <ul className="worktree-list">
                    {worktrees.map(worktree => {
                        const running = sessions.some(session => session.worktreePath === worktree.path && session.isAgent && !session.exited);
                        const link = parent.links[worktree.path];
                        const agentState = agentStateOf(sessions, new Set([worktree.path]));
                        const dotClass = agentState ?? (running ? 'running' : '');
                        const dotTitle = agentState ? AGENT_STATE_LABELS[agentState] : running ? 'Agent is running' : 'No agent';
                        const pr = worktree.branch ? summaries[worktree.branch] : undefined;
                        const name = worktree.branch ?? `detached ${worktree.head.slice(0, 7)}`;
                        return (
                            <li
                                key={worktree.path}
                                className={`worktree-row${worktree.path === selectedPath && !parent.tasksActive && !parent.settingsActive && !parent.agentsActive && !parent.reviewActive && !parent.dashboardActive && !parent.notesActive && !parent.pipelinesActive ? ' selected' : ''}`}
                                title={worktree.path}
                                onClick={() => parent.onSelect(worktree)}
                                onContextMenu={event => {
                                    event.preventDefault();
                                    parent.onWorktreeMenu(repo, worktree);
                                }}
                            >
                                <span className={`status-dot ${dotClass}`} title={dotTitle} />
                                <div className="worktree-text">
                                    <div className="worktree-name">{name}</div>
                                    <div className="worktree-detail">
                                        {agentState && agentState !== 'idle' && agentState !== 'exited' && (
                                            <span className={`agent-state ${agentState}`}>{AGENT_STATE_LABELS[agentState]}</span>
                                        )}
                                        {link ? (
                                            <button
                                                className="worktree-task"
                                                title={`Open the task: ${link.title}`}
                                                onClick={event => {
                                                    event.stopPropagation();
                                                    parent.onOpenTask(worktree.path);
                                                }}
                                            >
                                                {link.key ? `${link.key} · ` : ''}{link.title}
                                            </button>
                                        ) : worktree.isMain ? 'main worktree' : basename(worktree.path)}
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
                    })}
                </ul>
            )}
        </li>
    );
}

/** The left sidebar: the project, the Tasks view, the repositories of the project with their worktrees, and Settings. */
export function Sidebar(props: Props) {
    const [collapsed, setCollapsed] = useState(readCollapsed);
    /** The agents of all projects that still run, and the state that needs the user most. */
    const runningAgents = props.sessions.filter(session => session.isAgent && !session.exited).length;
    const agentsState = worktreeAgentState(props.sessions.filter(session => session.isAgent && !session.exited).map(session => session.agentState));

    const toggle = (repo: string) => setCollapsed(current => {
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
        <aside className="sidebar">
            <div className="sidebar-titlebar" />
            <div className="brand">
                <Logo size={26} />
                <span className="brand-name">ShipWarden</span>
            </div>

            <button className={`nav-row${props.dashboardActive ? ' selected' : ''}`} onClick={props.onOpenDashboard}>
                <LayoutDashboard size={15} strokeWidth={1.6} />
                <span className="nav-row-label">Dashboard</span>
                {props.dashboardCount > 0 && <span className="nav-row-count attention">{props.dashboardCount}</span>}
            </button>
            <button className={`nav-row${props.agentsActive ? ' selected' : ''}`} onClick={props.onOpenAgents}>
                <Bot size={15} strokeWidth={1.6} />
                <span className="nav-row-label">Agents</span>
                {agentsState && <span className={`status-dot ${agentsState}`} title={AGENT_STATE_LABELS[agentsState]} />}
                {runningAgents > 0 && <span className="nav-row-count">{runningAgents}</span>}
            </button>
            {props.repos.length > 0 && (
                <button className={`nav-row${props.tasksActive ? ' selected' : ''}`} onClick={props.onOpenTasks}>
                    <ListTodo size={15} strokeWidth={1.6} />
                    <span className="nav-row-label">Tasks</span>
                </button>
            )}

            <button className={`nav-row${props.reviewActive ? ' selected' : ''}`} onClick={props.onOpenReview}>
                <GitPullRequest size={15} strokeWidth={1.6} />
                <span className="nav-row-label">Review</span>
            </button>
            <button className={`nav-row${props.pipelinesActive ? ' selected' : ''}`} onClick={props.onOpenPipelines}>
                <Workflow size={15} strokeWidth={1.6} />
                <span className="nav-row-label">Pipelines</span>
            </button>
            <button className={`nav-row${props.notesActive ? ' selected' : ''}`} onClick={props.onOpenNotes}>
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

            <ul className="repo-list">
                {props.repos.map(repo => (
                    <RepoGroup key={repo} repo={repo} collapsed={collapsed.has(repo)} onToggle={() => toggle(repo)} parent={props} />
                ))}
                {props.projects && props.repos.length === 0 && (
                    <li className="repo-empty">
                        <button className="button" onClick={props.onAddRepo}>Add a repository</button>
                    </li>
                )}
            </ul>

            <div className="sidebar-footer">
                <button className={`nav-row${props.settingsActive ? ' selected' : ''}`} title="Settings (⌘,)" onClick={props.onOpenSettings}>
                    <Settings size={15} strokeWidth={1.6} />
                    <span>Settings</span>
                </button>
            </div>
        </aside>
    );
}
