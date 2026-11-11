import type { Dispatch, SetStateAction } from 'react';
import type { AgentMode } from '@shared/agent-modes';
import type { PullRequest, RepoRef } from '@shared/github';
import type { ProjectsState } from '@shared/projects';
import type { AppSettings, AgentDefinition, RepoScript } from '@shared/settings';
import { applyStartStatus, branchNameForTask, taskPrompt, type StartStatusResult, type Task, type TaskLink } from '@shared/tasks';
import { isOpenShell, openShellCount, type TerminalSession } from '@shared/terminal';
import { snoozeEnd, worktreeLabel, type CreatedWorktree, type HiddenWorktree, type Worktree } from '@shared/worktrees';
import { confirmDialog, promptDialog } from '../components/ConfirmDialog';
import { showContextMenu } from '../components/ContextMenu';
import type { GraphWorktreeStart } from '../components/GitGraphView';
import type { NewWorktreeRequest } from '../components/NewWorktreeDialog';
import { documents } from '../editor/documents';
import { agentStateStore, withAgentStore } from '../terminal/agent-state-store';
import { terminalPool } from '../terminal/terminal-pool';
import { withoutKey, type ExtraTab } from './tabs';
import type { MainView } from './views';
import {
    errorText,
    removeWorktreeDialog,
    sameRepoRef,
    snoozeChoice,
    teardownFailure,
    withHiddenWorktree,
    withRepoScripts,
    withWorktreeName,
    worktreeMenuItems
} from './worktree-edits';
import { editorPositions } from '../editor/editor-positions';
import { outputActivity } from '../terminal/output-activity';
import { keyRoots, queryClient } from '../query-client';
import { taskManagerKeys } from '../components/task-managers-cache';
import { listPatch, taskQueryKeys } from '../components/tasks/task-view-logic';
import { patchCachedTask } from '../components/tasks/use-task-list';
import { saveTaskLink } from './task-links';

const api = window.shipwarden;

/** A request for the New worktree dialog: the repository, and an optional start point. */
export interface NewWorktreeTarget {
    repo: string;
    start?: GraphWorktreeStart;
    /** A prompt for the agent of the new worktree. ShipWarden sends it after it creates the worktree. */
    prompt?: string;
}

interface Options {
    appSettings: AppSettings;
    setAppSettings: (settings: AppSettings) => void;
    activeProjectId: string | undefined;
    /** All projects. Undefined while they load. */
    projects: ProjectsState | undefined;
    /** Makes a project active. With `keepView`, the main view does not change. */
    switchProject: (id: string, keepView?: boolean) => Promise<void>;
    repos: string[];
    worktreesByRepo: Record<string, Worktree[]>;
    worktrees: Worktree[];
    refreshWorktrees: (repo: string) => Promise<Worktree[]>;
    sessions: TerminalSession[];
    setSessions: Dispatch<SetStateAction<TerminalSession[]>>;
    links: Record<string, TaskLink>;
    openFiles: Record<string, string[]>;
    setOpenFiles: Dispatch<SetStateAction<Record<string, string[]>>>;
    setExtraTabs: Dispatch<SetStateAction<Record<string, ExtraTab[]>>>;
    selectedPath: string | undefined;
    setSelectedPath: (path: string | undefined) => void;
    setMainView: (view: MainView) => void;
    setNewWorktree: (target: NewWorktreeTarget) => void;
    setTaskOpen: (request: { connectionId: string; taskId: string; nonce: number }) => void;
    startTerminal: (worktree: Worktree, target: 'shell' | 'agent' | AgentDefinition) => Promise<TerminalSession | undefined>;
    sendToAgent: (prompt: string, worktree?: Worktree) => Promise<void>;
    /** Sends a prompt to an agent without a banner and without a change of the selected tab. See `useAgentActions`. */
    promptAgent: (
        worktree: Pick<Worktree, 'path'>,
        prompt: string,
        target?: { sessionId?: string; agentId?: string; repoPath?: string; mode?: AgentMode }
    ) => Promise<TerminalSession>;
    prepareWorktree: (repoPath: string, worktree: CreatedWorktree) => Promise<void>;
    setError: (error: string | undefined) => void;
}

/** The actions that create, change and remove worktrees, and that start work on a task. */
export function useWorktreeActions(options: Options) {
    const { appSettings, setAppSettings, links, selectedPath, setSelectedPath, setMainView, refreshWorktrees, setError } = options;

    /** Sets or removes (with an empty name) the display name of a worktree. */
    const setWorktreeName = async (path: string, name: string | undefined) => {
        setAppSettings(await api.settings.update({ worktreeNames: withWorktreeName(appSettings.worktreeNames, path, name) }));
    };

    /**
     * Hides a worktree in the sidebar, or shows it again with `undefined`. With `until`, the worktree is snoozed and
     * shows again at that time. The worktree stays on disk. The update also removes the snoozes that ended.
     */
    const setWorktreeHidden = async (path: string, hidden: HiddenWorktree | undefined) => {
        setAppSettings(await api.settings.update({ hiddenWorktrees: withHiddenWorktree(appSettings.hiddenWorktrees, path, hidden, Date.now()) }));
    };

    /** Saves the scripts of a repository. An empty list removes the scripts from its settings. */
    const saveScripts = async (repoPath: string, scripts: RepoScript[]) => {
        setAppSettings(await api.settings.update({ repos: withRepoScripts(appSettings.repos, repoPath, scripts) }));
    };

    /**
     * Moves a task to the status with the name `wanted` (without case). Returns the result. Throws when a request fails.
     * The cached lists and details show the new status before the request ends. A failure puts the old status back.
     */
    const moveTaskToStatus = async (task: Task, connectionId: string, wanted: string): Promise<StartStatusResult> => {
        // The settings page and the Tasks view use the same cache entries, so a fresh copy does not load again.
        const source = await queryClient.fetchQuery({
            queryKey: taskQueryKeys.source(connectionId),
            queryFn: () => api.tasks.source(connectionId)
        });
        const listKey = [...keyRoots.tasks, 'list', connectionId];
        let moving = false;
        try {
            return await applyStartStatus(
                task,
                wanted,
                source.capabilities,
                <T>(method: string, params: unknown) => api.tasks.request(connectionId, method, params) as Promise<T>,
                {
                    onMoving: status => {
                        moving = true;
                        // A list that loads now must not put the old status back.
                        void queryClient.cancelQueries({ queryKey: listKey });
                        patchCachedTask(queryClient, connectionId, task.id, { status });
                    },
                    onMoved: updated => {
                        if (updated) {
                            patchCachedTask(queryClient, connectionId, task.id, listPatch(updated));
                        } else {
                            // The plugin sent no task, so the cache cannot know the other changes. Load the data again.
                            void queryClient.invalidateQueries({ queryKey: listKey });
                            void queryClient.invalidateQueries({ queryKey: taskQueryKeys.detail(connectionId, task.id) });
                        }
                    }
                }
            );
        } catch (err) {
            if (moving) patchCachedTask(queryClient, connectionId, task.id, { status: task.status });
            throw err;
        }
    };

    /**
     * Moves a task to the start status of its connection (Settings › Task managers), for example "in progress".
     * The worktree and the agent do not wait for it. A failure shows as an error, and the task keeps its status.
     */
    const moveTaskToStartStatus = async (task: Task, connectionId: string) => {
        let wanted: string | undefined;
        try {
            const connections = await queryClient.fetchQuery({ queryKey: taskManagerKeys.allConnections, queryFn: () => api.tasks.connections() });
            wanted = connections.find(item => item.id === connectionId)?.startStatus;
            if (!wanted) return;
            await moveTaskToStatus(task, connectionId, wanted);
        } catch (err) {
            setError(`${task.key ?? task.title} did not move to "${wanted}": ${errorText(err)}`);
        }
    };

    /**
     * Starts work on a task: creates a worktree with a branch for the task, links the worktree to the task
     * and sends the task to a new agent in the worktree.
     */
    const startTask = async (task: Task, connectionId: string, pluginId: string, repoPath: string) => {
        const branch = branchNameForTask(task);
        const worktree = await api.worktrees.create({ repoPath, branch });
        await options.prepareWorktree(repoPath, worktree);
        const link: TaskLink = { connectionId, pluginId, taskId: task.id, key: task.key, title: task.title, url: task.url };
        await saveTaskLink(queryClient, worktree.path, link);
        await refreshWorktrees(repoPath);
        setSelectedPath(worktree.path);
        setMainView('worktree');
        void moveTaskToStartStatus(task, connectionId);
        await options.sendToAgent(taskPrompt(task, branch), worktree);
    };

    /**
     * Starts work on a task for an automation: the same steps as `startTask`, but the selected worktree and the view do
     * not change. `prompt` replaces the default task prompt. Returns the new worktree and the agent session.
     */
    const startTaskQuietly = async (
        task: Task,
        connectionId: string,
        pluginId: string,
        repoPath: string,
        prompt: (branch: string) => string,
        agentId?: string,
        mode?: AgentMode
    ): Promise<{ worktree: CreatedWorktree; session: TerminalSession }> => {
        const branch = branchNameForTask(task);
        const worktree = await api.worktrees.create({ repoPath, branch });
        await options.prepareWorktree(repoPath, worktree);
        const link: TaskLink = { connectionId, pluginId, taskId: task.id, key: task.key, title: task.title, url: task.url };
        await saveTaskLink(queryClient, worktree.path, link);
        await refreshWorktrees(repoPath);
        void moveTaskToStartStatus(task, connectionId);
        const session = await options.promptAgent(worktree, prompt(branch), { agentId, repoPath, mode });
        return { worktree, session };
    };

    /**
     * Makes a worktree with a new branch from the newest default branch, and sends the prompt to a new agent in it.
     * For a scheduled automation. The selected worktree and the view do not change.
     */
    const startInNewWorktree = async (
        repoPath: string,
        branch: string,
        prompt: string,
        agentId?: string,
        mode?: AgentMode
    ): Promise<{ worktree: CreatedWorktree; session: TerminalSession }> => {
        const worktree = await api.worktrees.create({ repoPath, branch });
        await options.prepareWorktree(repoPath, worktree);
        await refreshWorktrees(repoPath);
        const session = await options.promptAgent(worktree, prompt, { agentId, repoPath, mode });
        return { worktree, session };
    };

    /**
     * Opens a worktree for the head branch of a pull request from the Review view. A worktree that has the branch opens.
     * Else the New worktree dialog opens on the remote branch.
     * When the active project does not have the repository, ShipWarden makes the first project that has it active.
     * With a prompt, ShipWarden sends the prompt to the agent of the worktree. For a new worktree, it sends the prompt after the dialog creates it.
     */
    const openPullRequestWorktree = async (repo: RepoRef, pr: Pick<PullRequest, 'headRefName'>, prompt?: string) => {
        const found = await findRepoPath(repo);
        if (!found) {
            setError(`No project has a repository with ${repo.owner}/${repo.name} as its "origin" remote. Add a clone of it to a project.`);
            return;
        }
        const { projectId, repoPath } = found;
        let worktrees = options.worktreesByRepo[repoPath];
        if (projectId !== options.activeProjectId) {
            await options.switchProject(projectId, true);
            // The worktree list of this render is for the old project.
            worktrees = await refreshWorktrees(repoPath);
        }
        const existing = worktrees?.find(worktree => worktree.branch === pr.headRefName);
        if (existing) {
            setSelectedPath(existing.path);
            setMainView('worktree');
            if (prompt) await options.sendToAgent(prompt, existing);
            return;
        }
        options.setNewWorktree({ repo: repoPath, start: { remote: `origin/${pr.headRefName}` }, ...(prompt ? { prompt } : {}) });
    };

    /**
     * Finds the repository folder with the GitHub repository as its "origin" remote. The active project comes first.
     * Then the other projects come in their order. Returns undefined when no project has the repository.
     */
    const findRepoPath = async (repo: RepoRef): Promise<{ projectId: string; repoPath: string } | undefined> => {
        const active = options.activeProjectId;
        const projects = options.projects?.projects ?? [];
        const candidates = [
            ...(active ? options.repos.map(repoPath => ({ projectId: active, repoPath })) : []),
            ...projects.filter(project => project.id !== active).flatMap(project => project.repos.map(repoPath => ({ projectId: project.id, repoPath })))
        ];
        for (const candidate of candidates) {
            const remote = await queryClient
                .fetchQuery({ queryKey: [...keyRoots.repoOf, candidate.repoPath], queryFn: () => api.github.repoOf(candidate.repoPath) })
                .catch(() => null);
            if (sameRepoRef(remote, repo)) {
                return candidate;
            }
        }
        return undefined;
    };

    /**
     * Creates a worktree from the New worktree dialog: its branch, start point, display name and agent.
     * With a prompt, ShipWarden sends the prompt to an agent of the new worktree, also when "startAgent" is false.
     */
    const createWorktree = async (repoPath: string, request: NewWorktreeRequest, prompt?: string) => {
        const worktree = await api.worktrees.create({
            repoPath,
            branch: request.branch,
            ...(request.baseRef ? { baseRef: request.baseRef } : {}),
            ...(request.trackRef ? { trackRef: request.trackRef } : {})
        });
        if (request.name) await setWorktreeName(worktree.path, request.name);
        await refreshWorktrees(repoPath);
        setSelectedPath(worktree.path);
        // The dialog can open from the Review view or the commit graph. The new worktree shows in all cases.
        setMainView('worktree');
        await options.prepareWorktree(repoPath, worktree);
        // Do not wait for the prompt. The agent can show a question, for example a folder trust question. The user must
        // answer it in the agent tab, and the open dialog blocks that tab. The dialog closes when this function returns.
        if (prompt) void options.sendToAgent(prompt, worktree).catch(err => setError(errorText(err)));
        else if (request.startAgent) await options.startTerminal(worktree, 'agent');
    };

    const renameWorktree = async (worktree: Worktree) => {
        const name = await promptDialog({
            title: 'Rename the worktree',
            message: `The sidebar shows this name. The branch "${worktree.branch ?? worktree.head.slice(0, 7)}" does not change. An empty name shows the branch again.`,
            value: appSettings.worktreeNames?.[worktree.path] ?? '',
            placeholder: worktree.branch ?? 'Name',
            confirmLabel: 'Rename'
        });
        if (name === undefined) return;
        try {
            await setWorktreeName(worktree.path, name);
        } catch (err) {
            setError(errorText(err));
        }
    };

    /**
     * Removes the state of a removed worktree from the page: its terminals, files, tabs, task link, name and hidden state.
     * Selects another worktree when the removed worktree was selected.
     */
    const forgetWorktree = async (repoPath: string, worktree: Worktree) => {
        options.sessions
            .filter(session => session.worktreePath === worktree.path)
            .forEach(session => {
                terminalPool.dispose(session.id);
                agentStateStore.delete(session.id);
                outputActivity.delete(session.id);
            });
        options.setSessions(list => list.filter(session => session.worktreePath !== worktree.path));
        (options.openFiles[worktree.path] ?? []).forEach(path => documents.close(worktree.path, path));
        editorPositions.forget(worktree.path);
        options.setExtraTabs(map => withoutKey(map, worktree.path));
        if (links[worktree.path]) await saveTaskLink(queryClient, worktree.path, null);
        options.setOpenFiles(map => withoutKey(map, worktree.path));
        if (appSettings.worktreeNames?.[worktree.path]) await setWorktreeName(worktree.path, undefined);
        if (appSettings.hiddenWorktrees?.[worktree.path]) await setWorktreeHidden(worktree.path, undefined);
        const list = await refreshWorktrees(repoPath);
        if (selectedPath === worktree.path) {
            setSelectedPath(list[0]?.path ?? options.worktrees.find(item => item.path !== worktree.path)?.path);
        }
    };

    /**
     * Removes a worktree for an automation, without questions. Git refuses a worktree with uncommitted changes, and a
     * failed teardown script stops the removal. With `deleteBranch`, a merged local branch goes away too. A branch that
     * is not merged stays. Returns a message for the run history. Throws an error with a message.
     */
    const removeWorktreeQuietly = async (repoPath: string, worktree: Worktree, deleteBranch: boolean): Promise<string> => {
        const result = await api.worktrees.remove(repoPath, worktree.path);
        if (result.teardownFailed) {
            throw new Error(`${teardownFailure(result.teardownFailed).title} The worktree stays.`);
        }
        await forgetWorktree(repoPath, worktree);
        if (!deleteBranch || !worktree.branch) return 'Removed the worktree.';
        const deleted = await api.worktrees.deleteBranch(repoPath, worktree.branch);
        return deleted.notMerged
            ? `Removed the worktree. The branch "${worktree.branch}" has commits that are not merged, so it stays.`
            : `Removed the worktree and the branch "${worktree.branch}".`;
    };

    /**
     * Removes a worktree. With `deleteBranch`, the local branch is deleted after the worktree. Git refuses a branch with
     * commits that are not merged, so ShipWarden asks before it forces the delete. The remote branch stays.
     */
    const removeWorktree = async (repoPath: string, worktree: Worktree, removeOptions: { deleteBranch?: boolean } = {}) => {
        const name = appSettings.worktreeNames?.[worktree.path] ?? worktree.branch ?? worktree.path;
        const branch = removeOptions.deleteBranch ? worktree.branch : undefined;
        const hasTeardown = !!appSettings.repos[repoPath]?.worktrees?.teardownScript;
        if (!(await confirmDialog({ ...removeWorktreeDialog(name, branch, hasTeardown), danger: true }))) {
            return;
        }
        try {
            const result = await api.worktrees.remove(repoPath, worktree.path);
            if (result.teardownFailed) {
                const { title, tail } = teardownFailure(result.teardownFailed);
                if (
                    !(await confirmDialog({
                        title,
                        message: 'Remove the worktree anyway?',
                        detail: tail,
                        confirmLabel: 'Remove anyway',
                        danger: true
                    }))
                ) {
                    return;
                }
                await api.worktrees.remove(repoPath, worktree.path, { skipTeardown: true });
            }
            await forgetWorktree(repoPath, worktree);
            if (branch) {
                const deleted = await api.worktrees.deleteBranch(repoPath, branch);
                if (
                    deleted.notMerged &&
                    (await confirmDialog({
                        title: `The branch "${branch}" has commits that are not merged into another branch.`,
                        message: 'Delete the branch anyway? The commits are then lost, unless the remote branch has them.',
                        confirmLabel: 'Delete branch',
                        danger: true
                    }))
                ) {
                    await api.worktrees.deleteBranch(repoPath, branch, true);
                }
            }
        } catch (err) {
            setError(errorText(err));
        }
    };

    /** Opens the task of a worktree in the Tasks view, with the task manager of the task selected. */
    const openLinkedTask = (worktreePath: string) => {
        const link = links[worktreePath];
        if (!link) return;
        options.setTaskOpen({ connectionId: link.connectionId ?? link.pluginId, taskId: link.taskId, nonce: Date.now() });
        setMainView('tasks');
    };

    /** The context menu of a worktree in the sidebar. */
    /**
     * Closes the shell tabs of a worktree after the user agrees. Agent tabs and shells with an agent in them stay open.
     * Each tab closes when the exit event of its session gets to the page.
     */
    const closeShells = async (worktree: Worktree) => {
        const shells = withAgentStore(options.sessions).filter(session => session.worktreePath === worktree.path && isOpenShell(session));
        if (!shells.length) return;
        const count = shells.length === 1 ? '1 shell' : `${shells.length} shells`;
        const ok = await confirmDialog({
            title: `Close ${count} in "${worktreeLabel(worktree, appSettings.worktreeNames)}"?`,
            message: 'The commands that run in them stop. Agent tabs stay open.',
            confirmLabel: 'Close',
            danger: true
        });
        if (!ok) return;
        const results = await Promise.allSettled(shells.map(session => api.terminals.kill(session.id)));
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) setError(errorText(failed.reason));
    };

    const worktreeMenu = async (repoPath: string, worktree: Worktree) => {
        const link = links[worktree.path];
        const shells = openShellCount(withAgentStore(options.sessions), worktree.path);
        const choice = await showContextMenu(worktreeMenuItems(worktree, link?.key, !!link, appSettings.hiddenWorktrees?.[worktree.path], Date.now(), shells));
        if (choice === 'task') openLinkedTask(worktree.path);
        if (choice === 'rename') await renameWorktree(worktree);
        if (choice === 'closeShells') await closeShells(worktree);
        try {
            if (choice === 'show') await setWorktreeHidden(worktree.path, undefined);
            if (choice === 'hide') await setWorktreeHidden(worktree.path, {});
            const option = snoozeChoice(choice);
            if (option) await setWorktreeHidden(worktree.path, { until: snoozeEnd(option, new Date()) });
        } catch (err) {
            setError(errorText(err));
        }
        if (choice === 'remove') await removeWorktree(repoPath, worktree);
        if (choice === 'removeBranch') await removeWorktree(repoPath, worktree, { deleteBranch: true });
    };

    return {
        startTask,
        startTaskQuietly,
        startInNewWorktree,
        moveTaskToStatus,
        createWorktree,
        openPullRequestWorktree,
        removeWorktree,
        removeWorktreeQuietly,
        saveScripts,
        openLinkedTask,
        worktreeMenu
    };
}
