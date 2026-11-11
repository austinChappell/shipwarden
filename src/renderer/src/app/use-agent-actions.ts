import type { Dispatch, SetStateAction } from 'react';
import type { NoteTarget } from '@shared/code-note';
import { agentModeLabel, agentStartCommand, claudeModeOnScreen, SHIFT_TAB, type AgentMode } from '@shared/agent-modes';
import { agentProgramOf } from '@shared/agent-programs';
import type { CheckRun, RepoTarget } from '@shared/github';
import { agentForRepo, type AgentDefinition, type AppSettings, type RepoScript } from '@shared/settings';
import type { TerminalSession } from '@shared/terminal';
import { setupCommand } from '@shared/worktree-settings';
import type { CreatedWorktree, Worktree } from '@shared/worktrees';
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
/** The most Shift+Tab presses that ShipWarden sends to find a permission mode of Claude Code. */
const MAX_MODE_PRESSES = 6;

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
 * Returns the text of the screen of a session. The page has a terminal only for a session that it showed. For other
 * sessions, for example an agent that an automation started, the main process makes the screen from the output.
 */
async function screenTextOf(sessionId: string): Promise<string | undefined> {
    return terminalPool.screenText(sessionId) ?? (await api.terminals.screenText(sessionId).catch(() => undefined));
}

/**
 * Puts a running Claude Code session in a permission mode. Claude Code goes to its next mode at each Shift+Tab, and its
 * status line shows the mode. Throws an error with a message when the mode does not come.
 */
async function switchClaudeMode(sessionId: string, mode: AgentMode): Promise<void> {
    for (let press = 0; press <= MAX_MODE_PRESSES; press++) {
        const screen = await screenTextOf(sessionId);
        if (screen === undefined) break;
        if (claudeModeOnScreen(screen) === mode) return;
        if (press === MAX_MODE_PRESSES) break;
        api.terminals.write(sessionId, SHIFT_TAB);
        await waitForQuietOutput(sessionId, 1500);
    }
    throw new Error(
        `ShipWarden did not put the agent in the mode "${agentModeLabel(mode)}". Claude Code shows a mode only when it is available. Check the mode in the agent tab.`
    );
}

/**
 * Waits until the agent screen shows no dialog. Calls `onDialog` one time when a dialog is visible.
 * Returns false when the dialog is still visible after the time limit.
 */
async function waitForNoDialog(sessionId: string, onDialog: () => void): Promise<boolean> {
    const deadline = Date.now() + AGENT_DIALOG_TIMEOUT_MS;
    let notified = false;
    while (Date.now() < deadline) {
        const screen = await screenTextOf(sessionId);
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
                command: agent ? agentStartCommand(definition) : undefined,
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

    /** Puts a running agent in a permission mode. Only Claude Code can change its mode while it runs. */
    const switchMode = async (session: TerminalSession, mode: AgentMode) => {
        const definition = appSettings.agents.find(agent => agent.name === session.title);
        const program = session.agentProgram ?? (definition ? agentProgramOf(definition.command) : undefined);
        if (program !== 'claude') {
            throw new Error(
                `The agent "${session.title}" runs already, and ShipWarden cannot change its mode. Close the agent tab, or set the mode in the agent tab.`
            );
        }
        await switchClaudeMode(session.id, mode);
    };

    /**
     * Sends a prompt to an agent for an automation. The user does not see a banner, and the selected tab does not
     * change. Throws an error with a message for the run history.
     * - With `sessionId`, the prompt goes to that agent session.
     * - Else it goes to the agent that runs in the worktree. Without one, a new session of `agentId` starts, else the
     *   agent of the repository.
     * - With `mode`, a new session starts in that permission mode. A running Claude Code session changes to the mode
     *   before the prompt. Other running agents cannot change their mode, so the run fails.
     * - Without `mode`, a new session starts in the default mode of the agent (Settings › Agents).
     * Returns the session that got the prompt.
     */
    const promptAgent = async (
        worktree: Pick<Worktree, 'path'>,
        prompt: string,
        target: { sessionId?: string; agentId?: string; repoPath?: string; mode?: AgentMode } = {}
    ): Promise<TerminalSession> => {
        let session = target.sessionId
            ? sessions.find(item => item.id === target.sessionId && !item.exited)
            : sessions.find(item => item.worktreePath === worktree.path && item.isAgent && !item.exited);
        if (target.sessionId && !session) {
            throw new Error('The agent tab closed.');
        }
        const fresh = !session;
        if (!session) {
            const definition = target.agentId
                ? appSettings.agents.find(agent => agent.id === target.agentId)
                : agentForRepo(appSettings, target.repoPath ?? repoOfWorktree(worktree.path));
            if (!definition) {
                throw new Error(`The agent "${target.agentId}" is not in Settings › Agents.`);
            }
            const command = agentStartCommand(definition, target.mode);
            const created = await api.terminals.create({
                cwd: worktree.path,
                worktreePath: worktree.path,
                title: definition.name,
                command,
                isAgent: true,
                cols: 120,
                rows: 32
            });
            setSessions(list => (list.some(item => item.id === created.id) ? list : [...list, created]));
            session = created;
            await waitForQuietOutput(created.id);
        }
        const id = session.id;
        if (!(await waitForNoDialog(id, () => undefined))) {
            throw new Error(
                fresh
                    ? 'The new agent shows a question, for example about folder trust. Answer it in the agent tab, then approve the run again.'
                    : 'The agent shows a question. Answer it in the agent tab, then approve the run again.'
            );
        }
        if (target.mode && !fresh) {
            await switchMode(session, target.mode);
        }
        api.terminals.write(id, bracketedPaste(prompt));
        setTimeout(() => api.terminals.write(id, '\r'), 200);
        return session;
    };

    /**
     * Saves the log of a GitHub Actions job and sends its path to an agent.
     * The default target is the selected worktree, and the default `send` sends the prompt to its agent.
     * The Review view gives the repository and a `send` that goes to the worktree of the head branch.
     */
    const sendLogToAgent = async (
        check: CheckRun,
        target: RepoTarget | undefined = selectedPath,
        send: (prompt: string) => Promise<void> = prompt => sendToAgent(prompt)
    ) => {
        if (!target) {
            return;
        }
        try {
            const logPath = await api.github.saveJobLog(target, check.id);
            await send(logPrompt(check.name, logPath));
        } catch (err) {
            setError(errorText(err));
        }
    };

    /**
     * Sends all the failed checks of the pull request to the agent in one prompt.
     * For a GitHub Actions job, the prompt has the path of the saved log. For other checks, it has the link.
     * The default target is the selected worktree, and the default `send` sends the prompt to its agent.
     * The Review view gives the repository and a `send` that goes to the worktree of the head branch.
     */
    const sendChecksToAgent = async (
        checks: CheckRun[],
        target: RepoTarget | undefined = selectedPath,
        send: (prompt: string) => Promise<void> = prompt => sendToAgent(prompt)
    ) => {
        if (!target || checks.length === 0) {
            return;
        }
        try {
            const lines = await Promise.all(
                checks.map(async check => checkLine(check, check.isActions ? await api.github.saveJobLog(target, check.id) : undefined))
            );
            await send(checksPrompt(lines));
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

    return { showSession, startTerminal, sendToAgent, promptAgent, sendLogToAgent, sendChecksToAgent, prepareWorktree, runScript };
}
