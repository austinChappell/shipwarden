import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import { agentStartCommand } from '@shared/agent-modes';
import { agentProgramOf } from '@shared/agent-programs';
import { resumeCommand, sessionIdOf, type PinRequest, type ResumePlan } from '@shared/pinned-sessions';
import type { AgentDefinition } from '@shared/settings';
import type { TranscriptSearchQuery } from '@shared/transcript-search';
import type { Services } from '../services';

type PinIpcDependencies = Pick<Services, 'pinnedSessions' | 'recentSessions' | 'transcriptIndex' | 'settings'>;

/** Returns the agent that resumes a session: the agent with the ID, or else the first Claude Code agent. */
async function resumeAgent(settings: Services['settings'], agentId?: string): Promise<AgentDefinition> {
    const { agents } = await settings.get();
    const claude = agents.filter(agent => agentProgramOf(agent.command.trim()) === 'claude');
    const agent = claude.find(item => item.id === agentId) ?? claude[0];
    if (!agent) throw new Error('Only Claude Code can resume a session. Add a Claude Code agent in Settings › Agents.');
    return agent;
}

/** Registers the IPC handlers of the pinned agent sessions, the recent agent sessions, and the transcript search. */
export function registerPinIpc({ pinnedSessions, recentSessions, transcriptIndex, settings }: PinIpcDependencies): void {
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
            const agent = await resumeAgent(settings, pin.agentId);
            return { command: resumeCommand(agentStartCommand(agent), pin.sessionId, pin.naming ? undefined : pin.name), agentName: agent.name };
        }
    );
    ipcMain.handle(IpcChannels.recentSessionsList, () => recentSessions.list());
    ipcMain.handle(IpcChannels.transcriptSearch, (_event, query: unknown) => {
        const value = (query ?? {}) as Partial<TranscriptSearchQuery>;
        return transcriptIndex.search({
            text: String(value.text ?? ''),
            folders: Array.isArray(value.folders) ? value.folders.map(String) : undefined,
            model: typeof value.model === 'string' ? value.model : undefined,
            since: typeof value.since === 'number' ? value.since : undefined
        });
    });
    ipcMain.handle(IpcChannels.recentSessionsPrepareResume, async (_event, transcript: unknown, target: { cwd?: unknown }): Promise<ResumePlan> => {
        const destination = await recentSessions.prepareResume(String(transcript ?? ''), String(target?.cwd ?? ''));
        const sessionId = sessionIdOf(destination);
        if (!sessionId) throw new Error('The transcript name is not a Claude Code session ID.');
        // A recent session has no name from ShipWarden. Claude Code keeps the title of the session.
        const agent = await resumeAgent(settings);
        return { command: resumeCommand(agentStartCommand(agent), sessionId), agentName: agent.name };
    });
}
