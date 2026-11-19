import { randomUUID } from 'crypto';
import * as path from 'path';
import { addTranscriptLines } from '@shared/agent-chat';
import {
    cleanSessionName,
    MAX_PINNED_SESSIONS,
    MAX_SESSION_NAME,
    normalizePinnedSession,
    sessionIdOf,
    sessionNamePrompt,
    sortPins,
    type PinnedSession,
    type PinRequest
} from '@shared/pinned-sessions';
import { JsonStore } from '../tasks/json-store';
import { claudeDataRoots } from '../automations/token-counter';
import { copyTranscriptFor } from './session-resume';
import { readTranscript, transcriptPath } from './transcript-reader';

interface PinFile {
    pins?: unknown[];
}

export interface PinnedSessionsOptions {
    file: string;
    /** Sends the new list to the page after each change. */
    onChanged: (pins: PinnedSession[]) => void;
    /** Asks an agent in print mode for an answer to the prompt. */
    ask: (pin: PinnedSession, prompt: string) => Promise<string>;
    roots?: () => readonly string[];
}

/** Where a resumed session runs. */
export interface ResumeTarget {
    cwd: string;
    repoPath?: string;
    branch?: string;
}

/**
 * Keeps the pinned Claude Code sessions in one JSON file in the app data folder. A new pin gets a name from an agent.
 * A resume in another folder copies the transcript into the Claude Code folder of that folder, because Claude Code
 * finds a session only in the folder of the current working folder.
 */
export class PinnedSessions {
    private readonly store: JsonStore<PinFile>;
    private readonly roots: () => readonly string[];

    constructor(private readonly options: PinnedSessionsOptions) {
        this.store = new JsonStore<PinFile>(options.file, () => ({ pins: [] }));
        this.roots = options.roots ?? claudeDataRoots;
    }

    /** All pins, the newest pin or resume first. */
    async list(): Promise<PinnedSession[]> {
        return pinsOf(await this.store.get());
    }

    /**
     * Pins a session and starts the agent that names it. A session that has a pin already keeps its pin and its name.
     * Throws an error when the transcript is not a Claude Code transcript.
     */
    async pin(request: PinRequest): Promise<PinnedSession> {
        const transcript = transcriptPath(String(request?.transcript ?? ''), this.roots());
        const sessionId = sessionIdOf(transcript);
        if (!sessionId) throw new Error('The transcript name is not a Claude Code session ID.');
        const cwd = String(request?.cwd ?? '').trim();
        if (!path.isAbsolute(cwd)) throw new Error('The folder of the session is not an absolute path.');
        const existing = (await this.list()).find(pin => pin.sessionId === sessionId);
        if (existing) {
            return this.change(existing.id, pin => ({ ...pin, transcript }));
        }
        const pin: PinnedSession = {
            id: randomUUID(),
            sessionId,
            transcript,
            name: cleanSessionName(String(request.fallbackName ?? '')) || 'Pinned session',
            naming: true,
            cwd,
            ...(request.repoPath ? { repoPath: String(request.repoPath) } : {}),
            ...(request.branch ? { branch: String(request.branch) } : {}),
            ...(request.agentId ? { agentId: String(request.agentId) } : {}),
            pinnedAt: Date.now()
        };
        await this.save(file => ({ pins: [pin, ...pinsOf(file)].slice(0, MAX_PINNED_SESSIONS) }));
        void this.name(pin.id);
        return pin;
    }

    /** Gives the pin the name of the user. The name stops a running name request of the agent. */
    async rename(id: string, name: string): Promise<PinnedSession> {
        const clean = cleanSessionName(name);
        if (!clean) throw new Error('Enter a name for the session.');
        return this.change(id, pin => ({ ...pin, name: clean, naming: undefined }));
    }

    async remove(id: string): Promise<void> {
        await this.save(file => ({ pins: pinsOf(file).filter(pin => pin.id !== id) }));
    }

    /**
     * Makes the session available to Claude Code in the target folder, and records the resume. A transcript of the
     * same session in the target folder stays when it is newer than the transcript of the pin. Returns the pin.
     */
    async prepareResume(id: string, target: ResumeTarget): Promise<PinnedSession> {
        const pin = (await this.list()).find(item => item.id === id);
        if (!pin) throw new Error('The pinned session is not in the list any more.');
        const cwd = String(target?.cwd ?? '').trim();
        if (!path.isAbsolute(cwd)) throw new Error('The folder of the resume is not an absolute path.');
        const destination = await copyTranscriptFor(transcriptPath(pin.transcript, this.roots()), pin.sessionId, cwd);
        return this.change(id, item => ({
            ...item,
            transcript: destination,
            cwd,
            repoPath: target.repoPath || undefined,
            branch: target.branch || undefined,
            resumedAt: Date.now()
        }));
    }

    /** Keeps the transcript path of a pin current when its session reports a transcript (for example after a resume). */
    async track(transcript: string | undefined): Promise<void> {
        const sessionId = transcript ? sessionIdOf(transcript) : undefined;
        if (!transcript || !sessionId) return;
        const pin = (await this.list()).find(item => item.sessionId === sessionId);
        if (pin && pin.transcript !== transcript) {
            await this.change(pin.id, item => ({ ...item, transcript }));
        }
    }

    /** Asks the agent for a name. A failure keeps the first name. */
    async name(id: string): Promise<void> {
        const pin = (await this.list()).find(item => item.id === id);
        if (!pin) return;
        if (!pin.naming) await this.change(id, item => ({ ...item, naming: true }));
        let name: string | undefined;
        try {
            const chunk = await readTranscript(pin.transcript, -1, this.roots());
            const answer = await this.options.ask(pin, sessionNamePrompt(addTranscriptLines([], chunk.lines)));
            name = cleanSessionName(answer).slice(0, MAX_SESSION_NAME) || undefined;
        } catch (error) {
            console.warn('ShipWarden did not get a name for the pinned session:', error);
        }
        // The user can rename the pin while the agent works. The name of the user stays.
        await this.change(id, item => ({ ...item, ...(name && item.naming ? { name } : {}), naming: undefined })).catch(() => undefined);
    }

    private async change(id: string, update: (pin: PinnedSession) => PinnedSession): Promise<PinnedSession> {
        let result: PinnedSession | undefined;
        await this.save(file => ({
            pins: pinsOf(file).map(pin => {
                if (pin.id !== id) return pin;
                result = normalizePinnedSession(update(pin)) ?? pin;
                return result;
            })
        }));
        if (!result) throw new Error('The pinned session is not in the list any more.');
        return result;
    }

    private async save(change: (file: PinFile) => PinFile): Promise<void> {
        const file = await this.store.update(change);
        this.options.onChanged(pinsOf(file));
    }
}

function pinsOf(file: PinFile): PinnedSession[] {
    const pins = (Array.isArray(file.pins) ? file.pins : []).map(normalizePinnedSession).filter((pin): pin is PinnedSession => !!pin);
    return sortPins(pins);
}
