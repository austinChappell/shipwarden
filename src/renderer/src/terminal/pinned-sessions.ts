import { useQuery } from '@tanstack/react-query';
import { transcriptAgentOf } from '@shared/agents';
import { pinOfTranscript, type PinnedSession, type PinRequest } from '@shared/pinned-sessions';
import type { AgentDefinition } from '@shared/settings';
import type { TerminalSession } from '@shared/terminal';
import { keyRoots, queryClient } from '../query-client';

const api = window.shipwarden;

let listening = false;

/** Puts each new list from the main process into the cache, for example the name that the agent gives. The list does not load again. */
function listen(): void {
    if (listening) return;
    listening = true;
    api.pins.onChanged(pins => queryClient.setQueryData<PinnedSession[]>(keyRoots.pins, pins));
}

/** The query of the pinned sessions. The main process sends each change, so the list loads only one time. */
export function pinnedSessionsQuery() {
    listen();
    return { queryKey: keyRoots.pins, queryFn: () => api.pins.list(), staleTime: Number.POSITIVE_INFINITY, refetchInterval: false as const };
}

/** The pinned sessions, the newest pin or resume first. */
export function usePinnedSessions(): PinnedSession[] {
    return useQuery(pinnedSessionsQuery()).data ?? [];
}

/** Returns the pin of a terminal session, if the session has a pin. */
export function pinOfSession(pins: readonly PinnedSession[], session: Pick<TerminalSession, 'agentTranscript'>): PinnedSession | undefined {
    return pinOfTranscript(pins, session.agentTranscript);
}

/** Returns true when ShipWarden can pin the session. Only a Claude Code session has a transcript that a resume can use. */
export function canPin(session: Pick<TerminalSession, 'agentTranscript' | 'exited'>): boolean {
    return transcriptAgentOf(session.agentTranscript) === 'claude';
}

/** Returns the data of a new pin for a terminal session. An agent tab has the name of its agent as its title. */
export function pinRequest(
    session: TerminalSession,
    agents: readonly AgentDefinition[],
    place: { repoPath?: string; branch?: string } = {}
): PinRequest | undefined {
    if (!session.agentTranscript || transcriptAgentOf(session.agentTranscript) !== 'claude') return undefined;
    const agent = session.isAgent ? agents.find(item => item.name === session.title) : undefined;
    return {
        transcript: session.agentTranscript,
        cwd: session.worktreePath ?? session.cwd,
        ...(place.repoPath ? { repoPath: place.repoPath } : {}),
        ...(place.branch ? { branch: place.branch } : {}),
        ...(agent ? { agentId: agent.id } : {}),
        ...(session.agentPrompt ? { fallbackName: session.agentPrompt } : {})
    };
}

/** Pins a session and puts the pin into the cache. */
export async function pinSession(request: PinRequest): Promise<PinnedSession> {
    const pin = await api.pins.pin(request);
    queryClient.setQueryData<PinnedSession[]>(keyRoots.pins, list => [pin, ...(list ?? []).filter(item => item.id !== pin.id)]);
    return pin;
}

/** Removes a pin and takes it out of the cache. The transcript of the session stays. */
export async function unpinSession(id: string): Promise<void> {
    await api.pins.remove(id);
    queryClient.setQueryData<PinnedSession[]>(keyRoots.pins, list => (list ?? []).filter(item => item.id !== id));
}

/** Gives a pin the name of the user, and puts the pin into the cache. */
export async function renamePin(id: string, name: string): Promise<PinnedSession> {
    const pin = await api.pins.rename(id, name);
    queryClient.setQueryData<PinnedSession[]>(keyRoots.pins, list => (list ?? []).map(item => (item.id === pin.id ? pin : item)));
    return pin;
}
