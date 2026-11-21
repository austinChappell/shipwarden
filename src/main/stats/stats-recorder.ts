import { idleReason } from '@shared/agent-overview';
import type { CompareGroup } from '@shared/agent-compare';
import type { AgentUpdate } from '@shared/agents';
import { pullRequestWebUrl, repoId, type MergeMethod, type RepoRef, type RepoTarget } from '@shared/github';
import type { StatsAgent } from '@shared/stats';
import type { TerminalSession } from '@shared/terminal';
import type { StatsStore } from './stats-store';

export interface StatsRecorderOptions {
    store: StatsStore;
    /** The terminal session with an ID. Undefined when the session is not known. */
    session(id: string): Promise<TerminalSession | undefined>;
    /** The repository of a worktree, from its "origin" remote. Null when it is not a known host. */
    repoOf(worktree: string): Promise<RepoRef | null>;
    /** All the tokens of a Claude Code transcript. */
    tokens(transcript: string): Promise<number>;
    /** The agent program of an agent in Settings › Agents, by its name. An agent tab has the name as its title. */
    programOf(agentName: string): Promise<string | undefined>;
    now?(): number;
}

/**
 * Writes the events of the agent stats. It adds the agent, the repository, and the tokens to each event.
 * Each method returns at once and never throws, because the stats must not slow or stop the app.
 */
export class StatsRecorder {
    /** The last state of each session that the log has, so a tool call that reports "working" again adds no line. */
    private readonly lastState = new Map<string, string>();
    /** The repository of each worktree. The "origin" remote seldom changes, so one read is enough. */
    private readonly repos = new Map<string, Promise<string | undefined>>();

    constructor(private readonly options: StatsRecorderOptions) {}

    /** Records a change of an agent's state. An update with the same state and the same wait as before adds no line. */
    agentState(id: string, update: AgentUpdate): void {
        const key = `${update.state}:${update.waitFor ?? ''}`;
        if (this.lastState.get(id) === key) return;
        this.lastState.set(id, key);
        void this.writeState(id, update).catch(error => console.warn(`[stats] The state event failed: ${String(error)}`));
    }

    /** Forgets a session that closed. */
    forget(id: string): void {
        this.lastState.delete(id);
    }

    /** Records a merge of a pull request. `target` is a worktree path or a repository. */
    merged(target: RepoTarget, number: number, method: MergeMethod): void {
        void this.writeMerge(target, number, method).catch(error => console.warn(`[stats] The merge event failed: ${String(error)}`));
    }

    /** Records the run that the user keeps in a comparison. A comparison without a kept run adds no line. */
    kept(group: CompareGroup): void {
        void this.writeCompare(group).catch(error => console.warn(`[stats] The compare event failed: ${String(error)}`));
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private async writeState(id: string, update: AgentUpdate): Promise<void> {
        const session = await this.options.session(id).catch(() => undefined);
        const agent = await this.agentOf(session);
        const transcript = update.transcript ?? session?.agentTranscript;
        const tokens = transcript ? await this.options.tokens(transcript).catch(() => undefined) : undefined;
        const reason = idleReason({
            agentState: update.state,
            waitFor: update.waitFor,
            now: update.at,
            exited: session?.exited,
            exitCode: session?.exitCode
        });
        this.options.store.append({
            type: 'state',
            at: update.at,
            session: id,
            ...agent,
            ...(update.model ? { model: update.model } : {}),
            state: update.state,
            ...(update.waitFor ? { waitFor: update.waitFor } : {}),
            ...(reason ? { reason } : {}),
            ...(transcript ? { transcript } : {}),
            ...(tokens ? { tokens } : {})
        });
    }

    private async writeMerge(target: RepoTarget, number: number, method: MergeMethod): Promise<void> {
        const worktree = typeof target === 'string' ? target : undefined;
        const ref = typeof target === 'string' ? await this.options.repoOf(target).catch(() => null) : target;
        this.options.store.append({
            type: 'merge',
            at: this.now(),
            ...(worktree ? { worktree } : {}),
            ...(ref ? { repo: repoId(ref), url: pullRequestWebUrl(ref, number) } : {}),
            number,
            method
        });
    }

    private async writeCompare(group: CompareGroup): Promise<void> {
        const winner = group.runs.find(run => run.worktreePath === group.keptPath);
        if (!winner) return;
        const runOf = (run: (typeof group.runs)[number]) => ({ agentId: run.agentId, agentName: run.agentName, worktree: run.worktreePath });
        const repo = await this.repoId(group.repoPath);
        this.options.store.append({
            type: 'compare',
            at: this.now(),
            compare: group.id,
            repoPath: group.repoPath,
            ...(repo ? { repo } : {}),
            task: group.task.key ? `${group.task.key} ${group.task.title}` : group.task.title,
            winner: runOf(winner),
            runs: group.runs.map(runOf)
        });
    }

    private async agentOf(session: TerminalSession | undefined): Promise<StatsAgent> {
        if (!session) return {};
        const repo = session.worktreePath ? await this.repoId(session.worktreePath) : undefined;
        // A shell tab knows its program from the process table. An agent tab gets it from its agent in the settings.
        const program = session.agentProgram ?? (session.isAgent ? await this.options.programOf(session.title).catch(() => undefined) : undefined);
        return {
            ...(session.worktreePath ? { worktree: session.worktreePath } : {}),
            ...(repo ? { repo } : {}),
            ...(program ? { program } : {}),
            agent: session.title,
            ...(session.agentModel ? { model: session.agentModel } : {})
        };
    }

    private repoId(worktree: string): Promise<string | undefined> {
        let repo = this.repos.get(worktree);
        if (!repo) {
            repo = this.options.repoOf(worktree).then(
                ref => (ref ? repoId(ref) : undefined),
                () => undefined
            );
            this.repos.set(worktree, repo);
        }
        return repo;
    }
}
