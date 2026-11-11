import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import type { CreateTerminalOptions } from '@shared/terminal';
import { shellIntegrationEnv } from '../agents/shell-integration';
import { loadGhosttySettings } from '../terminal/ghostty-loader';
import type { Services } from '../services';
import { onlyStrings, terminalCommand } from './args';
import { ScreenMirror } from '../remote/screen-mirror';

type TerminalIpcDependencies = Pick<
    Services,
    'terminals' | 'terminalSessions' | 'terminalSizes' | 'killTerminal' | 'shellAgents' | 'remote' | 'processes' | 'hookPaths' | 'shellIntegration'
>;

/** Registers the IPC handlers of the terminal sessions and the processes of the worktrees. */
export function registerTerminalIpc(deps: TerminalIpcDependencies): void {
    const { terminals, terminalSizes, shellAgents, remote, processes } = deps;
    ipcMain.handle(IpcChannels.terminalsSettings, () => loadGhosttySettings());
    ipcMain.handle(IpcChannels.terminalsList, deps.terminalSessions);
    ipcMain.handle(IpcChannels.terminalsCreate, async (_event, options: CreateTerminalOptions) => {
        const { command, reportsAgentState } = terminalCommand(options, deps.hookPaths);
        const env = { ...process.env, ...shellIntegrationEnv(process.env, deps.shellIntegration) };
        const session = await terminals.create({ ...options, command, reportsAgentState }, env);
        void shellAgents.poll();
        terminalSizes.set(session.id, { cols: options.cols, rows: options.rows });
        remote.agentsChanged();
        return session;
    });
    ipcMain.handle(IpcChannels.terminalsReplay, (_event, id: string) => terminals.replay(id));
    ipcMain.handle(IpcChannels.terminalsScreenText, async (_event, id: string) => {
        const sessionId = String(id);
        if (!(await deps.terminalSessions()).some(session => session.id === sessionId)) return undefined;
        // The page has no terminal for a session that it does not show. A headless terminal makes the screen from the replay.
        const size = terminalSizes.get(sessionId) ?? { cols: 120, rows: 32 };
        const mirror = new ScreenMirror(size.cols, size.rows);
        try {
            const replay = await terminals.replay(sessionId);
            await mirror.write(replay.data, replay.seq);
            return mirror.screenText();
        } finally {
            mirror.dispose();
        }
    });
    ipcMain.handle(IpcChannels.terminalsKill, (_event, id: string) => deps.killTerminal(String(id)));
    ipcMain.handle(IpcChannels.terminalsStopOutdated, async () => {
        const stopped = await terminals.shutdownOutdatedHosts();
        remote.agentsChanged();
        return stopped;
    });
    ipcMain.on(IpcChannels.terminalsWrite, (_event, id: string, data: string) => terminals.write(id, data));
    ipcMain.on(IpcChannels.terminalsResize, (_event, id: string, cols: number, rows: number) => {
        terminals.resize(id, cols, rows);
        if (cols > 0 && rows > 0) {
            terminalSizes.set(id, { cols, rows });
            remote.terminalResized(id, cols, rows);
        }
    });

    ipcMain.handle(IpcChannels.processesList, (_event, worktreePaths: unknown) => processes.scan(onlyStrings(worktreePaths)));
    ipcMain.handle(IpcChannels.processesStop, (_event, worktreePath: string, pid: number) => processes.stop(String(worktreePath), Number(pid)));
}
