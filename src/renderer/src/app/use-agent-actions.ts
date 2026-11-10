import type { Dispatch, SetStateAction } from 'react';
import type { NoteTarget } from '@shared/code-note';
import type { CheckRun } from '@shared/github';
import type { LspMissingServer } from '@shared/lsp';
import { agentForRepo, type AgentDefinition, type AppSettings, type RepoScript } from '@shared/settings';
import type { TerminalSession } from '@shared/terminal';
import { setupCommand } from '@shared/worktree-settings';
import type { CreatedWorktree, Worktree } from '@shared/worktrees';
import { lspBridge } from '../lsp/bridge';
import { terminalPool } from '../terminal/terminal-pool';
import { bracketedPaste, checkLine, checksPrompt, logPrompt, repoFolderName, showsAgentDialog } from './agent-text';
import type { TabKey } from './tabs';
import { errorText } from './worktree-edits';

const api = window.shipwarden;

/** The time that an agent can take to start before ShipWarden sends it a prompt. */
const AGENT_START_TIMEOUT_MS = 15_000;
const AGENT_QUIET_MS = 1200;
/** The time that ShipWarden waits for the user to answer a dialog of the agent. */
const AGENT_DIALOG_TIMEOUT_MS = 120_000;

/**
 * Waits until a new terminal session prints output and then is quiet for a short time.
 * An agent such as Claude Code is then ready for input.
 */
function waitForQuietOutput(sessionId: string, timeout = AGENT_START_TIMEOUT_MS): Promise<void> {
    return new Promise(resolve => {
        let quietTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
            clearTimeout(quietTimer);
            clearTimeout(limit);
            unsubscribe();
            resolve();
        };
        const limit = setTimeout(finish, timeout);
        const unsubscribe = api.terminals.onData(id => {
            if (id === sessionId) {
                clearTimeout(quietTimer);
                quietTimer = setTimeout(finish, AGENT_QUIET_MS);
            }
        });
    });
}

/**
 * Waits until the agent screen shows no dialog. Calls `onDialog` one time when a dialog is visible.
 * Returns false when the dialog is still visible after the time limit.
 */
async function waitForNoDialog(sessionId: string, onDialog: () => void): Promise<boolean> {
    const deadline = Date.now() + AGENT_DIALOG_TIMEOUT_MS;
    let notified = false;
    while (Date.now() < deadline) {
        const screen = terminalPool.screenText(sessionId);
        if (screen !== undefined && !showsAgentDialog(screen)) {
            return true;
        }
        if (!notified) {
            notified = true;
            onDialog();
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        // After the user answers, the agent redraws. Wait until its output is quiet again.
        await waitForQuietOutput(sessionId, 3000);
    }
    return false;
}

interface Options {
    sessions: TerminalSession[];
    setSessions: Dispatch<SetStateAction<TerminalSession[]>>;
    appSettings: AppSettings;
    selectedPath: string | undefined;
    /** The selected worktree. It is undefined until the worktree list has the selected path. */
    selected: Worktree | undefined;
    repoOfWorktree: (path: string) => string | undefined;
    activate: (worktreePath: string, tab: TabKey) => void;
    setError: (error: string | undefined) => void;
}

/** The actions that start terminals and agents, and that send prompts to agents. */
export function useAgentActions({ sessions, setSessions, appSettings, selectedPath, selected, repoOfWorktree, activate, setError }: Options) {
    const showSession = (session: TerminalSession) => {
        setSessions(list => (list.some(item => item.id === session.id) ? list : [...list, session]));
        if (session.worktreePath) {
            activate(session.worktreePath, `t:${session.id}`);
        }
    };

    /**
     * Starts a command in a new terminal tab of a worktree, and shows the tab.
     * On a failure, the error banner shows `failure` and the error text.
     */
    const startCommand = async (worktreePath: string, title: string, command: string, failure: string) => {
        try {
            const session = await api.terminals.create({ cwd: worktreePath, worktreePath, title, command, cols: 120, rows: 32 });
            showSession(session);
            return session;
        } catch (err) {
            setError(`${failure}: ${errorText(err)}`);
            return undefined;
        }
    };

    /**
     * Starts a session in a worktree. "shell" starts a shell. "agent" shows the agent that runs in the worktree, or
     * starts the repository's agent (its own choice, else the default agent). An agent definition from the "+" menu
     * always starts a new session of that agent.
     */
    const startTerminal = async (worktree: Worktree, target: 'shell' | 'agent' | AgentDefinition): Promise<TerminalSession | undefined> => {
        const agent = target !== 'shell';
        const definition = typeof target === 'object' ? target : agentForRepo(appSettings, repoOfWorktree(worktree.path));
        if (target === 'agent') {
            const running = sessions.find(session => session.worktreePath === worktree.path && session.isAgent && !session.exited);
            if (running) {
                showSession(running);
                return running;
            }
        }
        try {
            const session = await api.terminals.create({
                cwd: worktree.path,
                worktreePath: worktree.path,
                title: agent ? definition.name : 'shell',
                command: agent ? definition.command : undefined,
                isAgent: agent,
                cols: 120,
                rows: 32
            });
            showSession(session);
            return session;
        } catch (err) {
            setError(errorText(err));
            return undefined;
        }
    };

    /**
     * Sends a prompt to an agent of a worktree (default: the selected worktree).
     * Without a target, the prompt goes to the agent that runs in the worktree. Else ShipWarden starts the agent of the repository.
     * A target selects an agent tab, or a new session of an agent definition.
     * The prompt goes in as a bracketed paste, so that new lines do not submit it early. Then Enter submits it.
     */
    const sendToAgent = async (prompt: string, worktree: Worktree | undefined = selected, target?: NoteTarget) => {
        if (!worktree) {
            return;
        }
        let running: TerminalSession | undefined;
        if (target?.kind === 'session') {
            running = sessions.find(session => session.id === target.id && !session.exited);
            if (!running) {
                setError('ShipWarden did not send the note, because the agent tab closed. Select another agent and try again.');
                return;
            }
        } else if (!target) {
            running = sessions.find(session => session.worktreePath === worktree.path && session.isAgent && !session.exited);
        }
        const definition = target?.kind === 'new' ? appSettings.agents.find(agent => agent.id === target.agentId) : undefined;
        if (target?.kind === 'new' && !definition) {
            setError('ShipWarden did not send the note, because the agent is not in Settings › Agents.');
            return;
        }
        const session = running ?? (await startTerminal(worktree, definition ?? 'agent'));
        if (!session) {
            return;
        }
        showSession(session);
        if (!running) {
            await waitForQuietOutput(session.id);
        }
        if (
            !(await waitForNoDialog(session.id, () =>
                setError('The agent asks a question. Answer it in the agent tab. ShipWarden sends the prompt after that.')
            ))
        ) {
            setError('ShipWarden did not send the prompt, because the agent still shows a question. Answer it and try again.');
            return;
        }
        setError(undefined);
        api.terminals.write(session.id, bracketedPaste(prompt));
        setTimeout(() => api.terminals.write(session.id, '\r'), 200);
    };

    const sendLogToAgent = async (check: CheckRun) => {
        if (!selectedPath) {
            return;
        }
        try {
            const logPath = await api.github.saveJobLog(selectedPath, check.id);
            await sendToAgent(logPrompt(check.name, logPath));
        } catch (err) {
            setError(errorText(err));
        }
    };

    /**
     * Sends all the failed checks of the pull request to the agent in one prompt.
     * For a GitHub Actions job, the prompt has the path of the saved log. For other checks, it has the link.
     */
    const sendChecksToAgent = async (checks: CheckRun[]) => {
        const root = selectedPath;
        if (!root || checks.length === 0) {
            return;
        }
        try {
            const lines = await Promise.all(
                checks.map(async check => checkLine(check, check.isActions ? await api.github.saveJobLog(root, check.id) : undefined))
            );
            await sendToAgent(checksPrompt(lines));
        } catch (err) {
            setError(errorText(err));
        }
    };

    /**
     * Runs after ShipWarden creates a worktree: reports a failed copy of the ignored files, and starts the setup script
     * of the repository in a "Setup" terminal tab, so the user sees its output.
     */
    const prepareWorktree = async (repoPath: string, worktree: CreatedWorktree) => {
        if (worktree.copyError) {
            setError(`ShipWarden did not copy the ignored files into the new worktree: ${worktree.copyError}`);
        }
        const script = appSettings.repos[repoPath]?.worktrees?.setupScript;
        if (!script) return;
        const command = setupCommand(script, { rootPath: repoPath, worktreePath: worktree.path, branch: worktree.branch, repoName: repoFolderName(repoPath) });
        await startCommand(worktree.path, 'Setup', command, 'The setup script did not start');
    };

    /** Runs a saved script of a repository in a new terminal tab of a worktree, with the variables of the setup script. */
    const runScript = async (repoPath: string, worktree: Worktree, script: RepoScript) => {
        const command = setupCommand(script.command, {
            rootPath: repoPath,
            worktreePath: worktree.path,
            branch: worktree.branch,
            repoName: repoFolderName(repoPath)
        });
        await startCommand(worktree.path, script.name, command, `The script "${script.name}" did not start`);
    };

    /**
     * Runs the install command of a missing language server in a new terminal tab of the worktree.
     * ShipWarden then looks for the server, and starts it when the install completes.
     */
    const installServer = async (worktreePath: string, server: LspMissingServer) => {
        if (!server.installCommand) return;
        const session = await startCommand(worktreePath, `Install ${server.name}`, server.installCommand, `The install of ${server.name} did not start`);
        if (session) void lspBridge.watchInstall(server.serverId);
    };

    return { showSession, startTerminal, sendToAgent, sendLogToAgent, sendChecksToAgent, prepareWorktree, runScript, installServer };
}
