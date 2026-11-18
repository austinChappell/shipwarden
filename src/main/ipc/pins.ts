import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import { agentStartCommand } from '@shared/agent-modes';
import { agentProgramOf } from '@shared/agent-programs';
import { resumeCommand, type PinRequest, type ResumePlan } from '@shared/pinned-sessions';
import type { Services } from '../services';

type PinIpcDependencies = Pick<Services, 'pinnedSessions' | 'settings'>;

/** Registers the IPC handlers of the pinned agent sessions. */
export function registerPinIpc({ pinnedSessions, settings }: PinIpcDependencies): void {
    ipcMain.handle(IpcChannels.pinsList, () => pinnedSessions.list());
    ipcMain.handle(IpcChannels.pinsPin, (_event, request: PinRequest) => pinnedSessions.pin(request));
    ipcMain.handle(IpcChannels.pinsRename, (_event, id: unknown, name: unknown) => pinnedSessions.rename(String(id), String(name ?? '')));
    ipcMain.handle(IpcChannels.pinsRemove, (_event, id: unknown) => pinnedSessions.remove(String(id)));
    ipcMain.handle(
        IpcChannels.pinsPrepareResume,
        async (_event, id: unknown, target: { cwd?: unknown; repoPath?: unknown; branch?: unknown }): Promise<ResumePlan> => {
            const pin = await pinnedSessions.prepareResume(String(id), {
                cwd: String(target?.cwd ?? ''),
                repoPath: typeof target?.repoPath === 'string' ? target.repoPath : undefined,
                branch: typeof target?.branch === 'string' ? target.branch : undefined
            });
            // The agent that ran the session resumes it, with its permission mode. Without it, the first Claude Code agent.
            const { agents } = await settings.get();
            const claude = agents.filter(agent => agentProgramOf(agent.command.trim()) === 'claude');
            const agent = claude.find(item => item.id === pin.agentId) ?? claude[0];
            if (!agent) throw new Error('Only Claude Code can resume a session. Add a Claude Code agent in Settings › Agents.');
            return { command: resumeCommand(agentStartCommand(agent), pin.sessionId, pin.naming ? undefined : pin.name), agentName: agent.name };
        }
    );
}
