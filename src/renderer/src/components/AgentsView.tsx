import { useEffect, useMemo, useState } from 'react';
import { Bot, ChevronRight } from 'lucide-react';
import { AGENT_STATE_LABELS, type AgentState } from '@shared/agents';
import type { ProjectsState } from '@shared/projects';
import type { RepoColor } from '@shared/settings';
import { RepoIcon } from './RepoIcon';
import { useAgentSessions } from '../terminal/agent-state-store';
import type { TaskLink } from '@shared/tasks';
import { runsAgent, type TerminalSession } from '@shared/terminal';
import type { Worktree } from '@shared/worktrees';
import { moveListFocus } from '../keyboard/list-nav';

const api = window.shipwarden;

interface Props {
    sessions: TerminalSession[];
    projects: ProjectsState | undefined;
    /** The task of each worktree, by worktree path. */
    links: Record<string, TaskLink>;
    /** The name of a repository: its name from the repository settings, else its folder name. */
    repoLabel(repo: string): string;
    repoColor(repo: string): RepoColor | undefined;
    /** Shows the tab of the agent. `projectId` is the project of the agent's worktree, if ShipWarden found one. */
    onOpen(session: TerminalSession, projectId: string | undefined): void;
}

/** The order of the states in a group. The first state needs the user most. */
const STATE_ORDER: AgentState[] = ['waiting', 'working', 'done', 'starting', 'idle', 'exited'];

/** Where a worktree is: its repository and its branch. */
interface Place {
    repo: string;
    worktree: Worktree;
}

/** Returns the time since a moment, for example "now", "3m" or "2h 5m". */
function since(at: number | undefined, now: number): string | undefined {
    if (!at) return undefined;
    const minutes = Math.floor((now - at) / 60_000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * The agents of all projects that still run, grouped by project. Each row shows the state, a name for the work
 * (the linked task, the last prompt or the branch), what the agent does now, and where it runs.
 */
export function AgentsView({ sessions: sessionList, projects, links, repoLabel, repoColor, onOpen }: Props) {
    const [places, setPlaces] = useState<Record<string, Place>>({});
    const sessions = useAgentSessions(sessionList);
    const [now, setNow] = useState(Date.now());

    const agents = useMemo(() => sessions.filter(runsAgent), [sessions]);
    const allRepos = useMemo(() => [...new Set((projects?.projects ?? []).flatMap(project => project.repos))], [projects]);

    // The worktrees of all repositories of all projects tell which project and branch each agent belongs to.
    const repoKey = allRepos.join('\0');
    useEffect(() => {
        let cancelled = false;
        Promise.all(allRepos.map(async repo => {
            try {
                return (await api.worktrees.list(repo)).map(worktree => [worktree.path, { repo, worktree }] as const);
            } catch {
                return [];
            }
        })).then(lists => {
            if (!cancelled) {
                setPlaces(Object.fromEntries(lists.flat()));
            }
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [repoKey, agents.length]);

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(timer);
    }, []);

    /** The groups: one for each project with agents, the active project first, then agents that are in no project. */
    const groups = useMemo(() => {
        const sorted = [...agents].sort((a, b) =>
            STATE_ORDER.indexOf(a.agentState ?? 'idle') - STATE_ORDER.indexOf(b.agentState ?? 'idle')
            || (a.agentStateAt ?? 0) - (b.agentStateAt ?? 0));
        const list = [...(projects?.projects ?? [])]
            .sort((a, b) => (a.id === projects?.activeId ? -1 : b.id === projects?.activeId ? 1 : 0))
            .map(project => ({
                id: project.id as string | undefined,
                name: project.name,
                agents: sorted.filter(session => {
                    const place = session.worktreePath ? places[session.worktreePath] : undefined;
                    return !!place && project.repos.includes(place.repo);
                })
            }))
            .filter(group => group.agents.length > 0);
        const other = sorted.filter(session => !session.worktreePath || !places[session.worktreePath]);
        if (other.length > 0) {
            list.push({ id: undefined, name: 'Other', agents: other });
        }
        return list;
    }, [agents, projects, places]);

    return (
        <div className="agents-view">
            <header className="agents-header">
                <h1>Agents</h1>
                <span className="agents-count">{agents.length} running</span>
            </header>
            <div className="agents-scroll" onKeyDown={moveListFocus}>
                {agents.length === 0 && (
                    <div className="agents-empty">
                        <Bot size={28} strokeWidth={1.4} />
                        <p>No agents run now.</p>
                        <p className="panel-note">Start one from a worktree with the Agent button, or from a task with "Start in worktree".</p>
                    </div>
                )}
                {groups.map(group => (
                    <section key={group.id ?? 'other'} className="agents-group">
                        <h2>
                            {group.name}
                            {group.id === projects?.activeId && <span className="agents-current">current project</span>}
                        </h2>
                        <div className="agents-list">
                            {group.agents.map(session => {
                                const place = session.worktreePath ? places[session.worktreePath] : undefined;
                                const link = session.worktreePath ? links[session.worktreePath] : undefined;
                                const branch = place?.worktree.branch ?? place?.worktree.path.split('/').pop();
                                const name = link ? `${link.key ? `${link.key} · ` : ''}${link.title}` : session.agentPrompt ?? branch ?? session.title;
                                const state = session.agentState;
                                const label = state ? AGENT_STATE_LABELS[state] : 'Running';
                                const time = since(session.agentStateAt, now);
                                return (
                                    <button key={session.id} className={`agent-row ${state ?? 'running'}`} data-nav-item onClick={() => onOpen(session, group.id)}>
                                        <span className={`status-dot ${state ?? 'running'}`} />
                                        <span className="agent-main">
                                            <span className="agent-name" title={name}>{name}</span>
                                            <span className="agent-activity" title={session.agentMessage}>
                                                {session.agentMessage ?? (state ? '' : `${session.title} has no status hooks, so ShipWarden shows only that it runs.`)}
                                            </span>
                                        </span>
                                        <span className="agent-side">
                                            <span className={`agent-state ${state ?? 'running'}`}>{label}{time ? ` · ${time}` : ''}</span>
                                            <span className="agent-where">
                                                {place && repoColor(place.repo) && <RepoIcon color={repoColor(place.repo)} size={12} />}
                                                {place ? `${repoLabel(place.repo)} · ${branch}` : session.cwd.split('/').pop()}
                                            </span>
                                        </span>
                                        <ChevronRight size={14} strokeWidth={1.8} className="agent-chevron" />
                                    </button>
                                );
                            })}
                        </div>
                    </section>
                ))}
            </div>
        </div>
    );
}
