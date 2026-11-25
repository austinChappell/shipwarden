import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { transcriptAgentOf } from '@shared/agents';
import { pinExpired, pinOfTranscript, type PinnedSession, type PinRequest, type PinState, type SessionTags } from '@shared/pinned-sessions';
import type { AgentDefinition } from '@shared/settings';
import type { TerminalSession } from '@shared/terminal';
import { keyRoots, queryClient } from '../query-client';

const api = window.shipwarden;

let listening = false;

/** Puts each new state from the main process into the cache, for example the name that the agent gives. The list does not load again. */
function listen(): void {
    if (listening) return;
    listening = true;
    api.pins.onChanged(state => queryClient.setQueryData<PinState>(keyRoots.pins, state));
}

/** The query of the pins and the session tags. The main process sends each change, so the state loads only one time. */
export function pinnedSessionsQuery() {
    listen();
    return { queryKey: keyRoots.pins, queryFn: () => api.pins.list(), staleTime: Number.POSITIVE_INFINITY, refetchInterval: false as const };
}

const NO_PINS: PinnedSession[] = [];
const NO_TAGS: SessionTags = {};

/** Changes the pins in the cache. */
function changePins(update: (pins: PinnedSession[]) => PinnedSession[]): void {
    queryClient.setQueryData<PinState>(keyRoots.pins, state => ({ pins: update(state?.pins ?? []), tags: state?.tags ?? {} }));
}

/** Puts a changed pin into the cache, at the top of the list. */
function putPin(pin: PinnedSession): void {
    changePins(list => [pin, ...list.filter(item => item.id !== pin.id)]);
}

/** The pinned sessions, the newest pin or resume first. The list does not include the unpinned sessions. */
export function usePinnedSessions(): PinnedSession[] {
    const pins = useQuery(pinnedSessionsQuery()).data?.pins ?? NO_PINS;
    return useMemo(() => pins.filter(pin => !pin.unpinnedAt), [pins]);
}

/** The recently unpinned sessions, the newest unpin first. The main process removes them after a few days. */
export function useUnpinnedSessions(): PinnedSession[] {
    const pins = useQuery(pinnedSessionsQuery()).data?.pins ?? NO_PINS;
    return useMemo(() => {
        const now = Date.now();
        return pins.filter(pin => pin.unpinnedAt && !pinExpired(pin, now)).sort((a, b) => (b.unpinnedAt ?? 0) - (a.unpinnedAt ?? 0));
    }, [pins]);
}

/** The tags of the sessions, by the session ID. */
export function useSessionTags(): SessionTags {
    return useQuery(pinnedSessionsQuery()).data?.tags ?? NO_TAGS;
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
    putPin(pin);
    return pin;
}

/** Unpins a session. The session moves to "Recently unpinned" in the cache. The transcript of the session stays. */
export async function unpinSession(id: string): Promise<void> {
    const pin = await api.pins.unpin(id);
    changePins(list => list.map(item => (item.id === pin.id ? pin : item)));
}

/** Pins a recently unpinned session again, and puts the pin into the cache. */
export async function restorePin(id: string): Promise<PinnedSession> {
    const pin = await api.pins.restore(id);
    putPin(pin);
    return pin;
}

/** Removes a pin or an unpinned session now, and takes it out of the cache. */
export async function removePin(id: string): Promise<void> {
    await api.pins.remove(id);
    changePins(list => list.filter(item => item.id !== id));
}

/** Gives a pin the name of the user, and puts the pin into the cache. */
export async function renamePin(id: string, name: string): Promise<PinnedSession> {
    const pin = await api.pins.rename(id, name);
    changePins(list => list.map(item => (item.id === pin.id ? pin : item)));
    return pin;
}

/** Gives a session its tags. The cache changes first, so the tags show at once. A failure puts the old tags back. */
export async function setSessionTags(sessionId: string, tags: string[]): Promise<void> {
    const before = queryClient.getQueryData<PinState>(keyRoots.pins);
    const write = (value: string[]) =>
        queryClient.setQueryData<PinState>(keyRoots.pins, state => {
            const { [sessionId]: _old, ...rest } = state?.tags ?? {};
            return { pins: state?.pins ?? [], tags: value.length > 0 ? { ...rest, [sessionId]: value } : rest };
        });
    write(tags);
    try {
        write(await api.pins.setTags(sessionId, tags));
    } catch (error) {
        write(before?.tags[sessionId] ?? []);
        throw error;
    }
}
