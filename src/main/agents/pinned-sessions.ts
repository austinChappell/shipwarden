import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { addTranscriptLines } from '@shared/agent-chat';
import { normalizeTags } from '@shared/notes';
import {
    cleanSessionName,
    MAX_PINNED_SESSIONS,
    MAX_SESSION_NAME,
    MAX_TAGGED_SESSIONS,
    normalizePinnedSession,
    normalizeSessionTags,
    pinExpired,
    sessionIdOf,
    sessionNamePrompt,
    sortPins,
    type PinnedSession,
    type PinRequest,
    type PinState,
    type SessionTags
} from '@shared/pinned-sessions';
import { JsonStore } from '../tasks/json-store';
import { claudeDataRoots } from '../automations/token-counter';
import { copyTranscriptFor, modifiedAt } from './session-resume';
import { readTranscript, transcriptPath } from './transcript-reader';

interface PinFile {
    pins?: unknown[];
    tags?: unknown;
}

export interface PinnedSessionsOptions {
    file: string;
    /** Sends the new pins and tags to the page after each change. */
    onChanged: (state: PinState) => void;
    /** Asks an agent in print mode for an answer to the prompt. */
    ask: (pin: PinnedSession, prompt: string) => Promise<string>;
    roots?: () => readonly string[];
    now?: () => number;
    /** The folder of the backup copies of the pinned transcripts. The default is "pinned-transcripts" next to `file`. */
    backupDir?: string;
}

/** Where a resumed session runs. */
export interface ResumeTarget {
    cwd: string;
    repoPath?: string;
    branch?: string;
}

/**
 * Keeps the pinned Claude Code sessions and the tags of the sessions in one JSON file in the app data folder. A new pin
 * gets a name from an agent. A pin stays until the user unpins it. An unpinned session stays for UNPINNED_KEEP_DAYS
 * days, so that the user can pin it again. A resume in another folder copies the transcript into the Claude Code folder
 * of that folder, because Claude Code finds a session only in the folder of the current working folder.
 *
 * Claude Code deletes old transcripts (the setting "cleanupPeriodDays"). So ShipWarden keeps a backup copy of the
 * transcript of each pin in `backupDir`. A resume uses the copy when the transcript of Claude Code is gone.
 */
export class PinnedSessions {
    private readonly store: JsonStore<PinFile>;
    private readonly roots: () => readonly string[];
    private readonly now: () => number;
    private readonly backupDir: string;
    /** The backup that runs now for each session ID. A new backup of the same session waits for it. */
    private readonly backups = new Map<string, Promise<void>>();

    constructor(private readonly options: PinnedSessionsOptions) {
        this.store = new JsonStore<PinFile>(options.file, () => ({ pins: [], tags: {} }));
        this.roots = options.roots ?? claudeDataRoots;
        this.now = options.now ?? Date.now;
        this.backupDir = options.backupDir ?? path.join(path.dirname(options.file), 'pinned-transcripts');
    }

    /** The path of the backup copy of the transcript of a session. */
    backupPath(sessionId: string): string {
        return path.join(this.backupDir, `${sessionId}.jsonl`);
    }

    /**
     * Updates the backup copies of all pins and of the recently unpinned sessions, and deletes the copies that have no pin.
     * A copy changes only when its transcript changed. Call it at the start of the app and from time to time, because
     * a session can continue outside ShipWarden.
     */
    async backupAll(): Promise<void> {
        const pins = await this.list();
        await Promise.all(pins.map(pin => this.backup(pin)));
        const keep = new Set(pins.map(pin => `${pin.sessionId}.jsonl`));
        const names = await fs.readdir(this.backupDir).catch(() => [] as string[]);
        await Promise.all(names.filter(name => !keep.has(name)).map(name => fs.rm(path.join(this.backupDir, name), { force: true })));
    }

    /**
     * Copies the transcript of a pin to its backup copy when the transcript is newer than the copy. A missing transcript
     * keeps the copy. A failure only logs a warning.
     */
    private backup(pin: PinnedSession): Promise<void> {
        const previous = this.backups.get(pin.sessionId) ?? Promise.resolve();
        const next = previous.then(async () => {
            try {
                const source = transcriptPath(pin.transcript, this.roots());
                const target = this.backupPath(pin.sessionId);
                const sourceTime = await modifiedAt(source);
                if (sourceTime === undefined) return;
                const targetTime = await modifiedAt(target);
                if (targetTime !== undefined && targetTime >= sourceTime) return;
                await fs.mkdir(this.backupDir, { recursive: true });
                // A copy to a temporary file and a rename: a crash during the copy does not damage the old copy.
                const temporary = `${target}.${randomUUID()}.tmp`;
                await fs.copyFile(source, temporary);
                await fs.rename(temporary, target);
            } catch (error) {
                console.warn('ShipWarden did not back up the transcript of the pinned session:', error);
            }
        });
        this.backups.set(pin.sessionId, next);
        void next.then(() => {
            if (this.backups.get(pin.sessionId) === next) this.backups.delete(pin.sessionId);
        });
        return next;
    }

    /** Deletes the backup copy of a session. The delete waits for a backup that runs now. */
    private async deleteBackup(sessionId: string): Promise<void> {
        await this.backups.get(sessionId);
        await fs.rm(this.backupPath(sessionId), { force: true }).catch(() => undefined);
    }

    /** The pins and the recently unpinned sessions, the newest pin or resume first. */
    async list(): Promise<PinnedSession[]> {
        return this.pinsOf(await this.store.get());
    }

    /** The pins, the recently unpinned sessions, and the tags of the sessions. */
    async state(): Promise<PinState> {
        return this.stateOf(await this.store.get());
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
            // A recently unpinned session gets its pin again, with its name.
            const updated = await this.change(existing.id, pin => ({
                ...pin,
                transcript,
                ...(pin.unpinnedAt ? { pinnedAt: this.now(), unpinnedAt: undefined } : {})
            }));
            void this.backup(updated);
            return updated;
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
            pinnedAt: this.now()
        };
        await this.save(file => {
            const pins = this.pinsOf(file);
            const pinned = pins.filter(item => !item.unpinnedAt).slice(0, MAX_PINNED_SESSIONS - 1);
            return { ...file, pins: [pin, ...pinned, ...pins.filter(item => item.unpinnedAt)] };
        });
        void this.backup(pin);
        void this.name(pin.id);
        return pin;
    }

    /** Gives the pin the name of the user. The name stops a running name request of the agent. */
    async rename(id: string, name: string): Promise<PinnedSession> {
        const clean = cleanSessionName(name);
        if (!clean) throw new Error('Enter a name for the session.');
        return this.change(id, pin => ({ ...pin, name: clean, naming: undefined }));
    }

    /** Unpins a session. The session moves to "Recently unpinned" and keeps its name and its tags. */
    async unpin(id: string): Promise<PinnedSession> {
        return this.change(id, pin => ({ ...pin, unpinnedAt: this.now() }));
    }

    /** Pins a recently unpinned session again. */
    async restore(id: string): Promise<PinnedSession> {
        return this.change(id, pin => (pin.unpinnedAt ? { ...pin, pinnedAt: this.now(), unpinnedAt: undefined } : pin));
    }

    /** Removes a pin or an unpinned session now. The tags of the session stay. */
    async remove(id: string): Promise<void> {
        await this.save(file => ({ ...file, pins: this.pinsOf(file).filter(pin => pin.id !== id) }));
    }

    /** Gives a session its tags. An empty list removes the tags. Returns the clean tags. */
    async setTags(sessionId: string, tags: unknown): Promise<string[]> {
        if (!sessionIdOf(`${sessionId}.jsonl`)) throw new Error('The session ID is not valid.');
        const clean = normalizeTags(tags);
        await this.save(file => {
            const { [sessionId]: _old, ...rest } = normalizeSessionTags(file.tags);
            // A changed session goes to the end, so the limit removes the tags of the sessions that changed first.
            return { ...file, tags: clean.length > 0 ? { ...rest, [sessionId]: clean } : rest };
        });
        return clean;
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
        const source = transcriptPath(pin.transcript, this.roots());
        await this.backups.get(pin.sessionId);
        // Claude Code can delete an old transcript. Then the backup copy is the source.
        const backup = this.backupPath(pin.sessionId);
        const useBackup = (await modifiedAt(source)) === undefined && (await modifiedAt(backup)) !== undefined;
        const destination = useBackup
            ? await copyTranscriptFor(backup, pin.sessionId, cwd, path.dirname(path.dirname(source)))
            : await copyTranscriptFor(source, pin.sessionId, cwd);
        return this.change(id, item => ({
            ...item,
            transcript: destination,
            cwd,
            repoPath: target.repoPath || undefined,
            branch: target.branch || undefined,
            resumedAt: this.now()
        }));
    }

    /**
     * Keeps the transcript path of a pin current when its session reports a transcript (for example after a resume), and
     * updates the backup copy.
     */
    async track(transcript: string | undefined): Promise<void> {
        const sessionId = transcript ? sessionIdOf(transcript) : undefined;
        if (!transcript || !sessionId) return;
        let pin = (await this.list()).find(item => item.sessionId === sessionId);
        if (pin && pin.transcript !== transcript) {
            pin = await this.change(pin.id, item => ({ ...item, transcript }));
        }
        if (pin) await this.backup(pin);
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
            ...file,
            pins: this.pinsOf(file).map(pin => {
                if (pin.id !== id) return pin;
                result = normalizePinnedSession(update(pin)) ?? pin;
                return result;
            })
        }));
        if (!result) throw new Error('The pinned session is not in the list any more.');
        return result;
    }

    /**
     * Saves a change. The save also removes the expired unpinned sessions and the tags after the limit, and deletes the
     * backup copies of the sessions that lost their pin.
     */
    private async save(change: (file: PinFile) => PinFile): Promise<void> {
        let removed: string[] = [];
        const file = await this.store.update(current => {
            const before = (Array.isArray(current.pins) ? current.pins : []).map(normalizePinnedSession).filter((pin): pin is PinnedSession => !!pin);
            const next = change(current);
            const pins = this.pinsOf(next);
            const kept = new Set(pins.map(pin => pin.sessionId));
            removed = before.map(pin => pin.sessionId).filter(id => !kept.has(id));
            return { pins, tags: limitTags(normalizeSessionTags(next.tags), kept) };
        });
        this.options.onChanged(this.stateOf(file));
        await Promise.all(removed.map(id => this.deleteBackup(id)));
    }

    private stateOf(file: PinFile): PinState {
        return { pins: this.pinsOf(file), tags: normalizeSessionTags(file.tags) };
    }

    /** The valid pins of the file without the expired unpinned sessions, the newest pin or resume first. */
    private pinsOf(file: PinFile): PinnedSession[] {
        const now = this.now();
        const pins = (Array.isArray(file.pins) ? file.pins : [])
            .map(normalizePinnedSession)
            .filter((pin): pin is PinnedSession => !!pin && !pinExpired(pin, now));
        return sortPins(pins);
    }
}

/** Keeps the tags of at most MAX_TAGGED_SESSIONS sessions. The tags of a pinned session always stay. */
function limitTags(tags: SessionTags, pinned: ReadonlySet<string>): SessionTags {
    const ids = Object.keys(tags);
    let extra = ids.length - MAX_TAGGED_SESSIONS;
    if (extra <= 0) return tags;
    const result: SessionTags = {};
    for (const id of ids) {
        if (extra > 0 && !pinned.has(id)) {
            extra--;
            continue;
        }
        result[id] = tags[id] as string[];
    }
    return result;
}
