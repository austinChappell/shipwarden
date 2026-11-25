import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PinnedSession, PinState } from '@shared/pinned-sessions';
import { PinnedSessions } from './pinned-sessions';

const ID = '1c9b47cc-a11d-4e49-a0f7-78590b290474';

const LINES = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Fix the flaky login test' } },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'The test waits for a timer.' }] } }
]
    .map(line => JSON.stringify(line))
    .join('\n');

describe('PinnedSessions', () => {
    let dir: string;
    let root: string;
    let transcript: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-pins-'));
        root = path.join(dir, '.claude');
        transcript = path.join(root, 'projects', '-w-app', `${ID}.jsonl`);
        await fs.mkdir(path.dirname(transcript), { recursive: true });
        await fs.writeFile(transcript, `${LINES}\n`);
    });
    afterEach(async () => {
        // The last write of the store can still run. The retries wait for it.
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    });

    /** Waits until the agent gave all names, so no write comes after the test. */
    async function settled(pins: PinnedSessions) {
        await vi.waitFor(async () => expect((await pins.list()).some(pin => pin.naming)).toBe(false));
    }

    function create(ask: (pin: PinnedSession, prompt: string) => Promise<string>, now?: () => number) {
        const changes: PinState[] = [];
        const pins = new PinnedSessions({ file: path.join(dir, 'pins.json'), onChanged: state => changes.push(state), ask, roots: () => [root], now });
        return { pins, changes };
    }

    it('pins a session with the fallback name, then takes the name of the agent', async () => {
        const ask = vi.fn(async (_pin: PinnedSession, _prompt: string) => '"Fix flaky login test"');
        const { pins, changes } = create(ask);
        const pin = await pins.pin({ transcript, cwd: '/w/app', repoPath: '/repo', branch: 'fix', fallbackName: 'fix the test' });
        expect(pin).toMatchObject({ sessionId: ID, name: 'fix the test', naming: true, cwd: '/w/app' });
        await vi.waitFor(async () => expect((await pins.list())[0]?.naming).toBeUndefined());
        expect((await pins.list())[0]?.name).toBe('Fix flaky login test');
        expect(ask.mock.calls[0]?.[1]).toContain('User: Fix the flaky login test');
        expect(changes.at(-1)?.pins[0]?.name).toBe('Fix flaky login test');
    });

    it('keeps the name of the user when the agent answers later', async () => {
        let answer: (value: string) => void = () => undefined;
        const { pins } = create(() => new Promise(resolve => (answer = resolve)));
        const pin = await pins.pin({ transcript, cwd: '/w/app' });
        await pins.rename(pin.id, 'My name');
        answer('Agent name');
        await new Promise(resolve => setTimeout(resolve, 20));
        expect((await pins.list())[0]?.name).toBe('My name');
    });

    it('keeps one pin for each session', async () => {
        const { pins } = create(async () => 'Name');
        const first = await pins.pin({ transcript, cwd: '/w/app' });
        const second = await pins.pin({ transcript, cwd: '/w/app' });
        expect(second.id).toBe(first.id);
        expect(await pins.list()).toHaveLength(1);
        await settled(pins);
    });

    it('refuses a transcript outside the Claude Code folder', async () => {
        const { pins } = create(async () => 'Name');
        await expect(pins.pin({ transcript: path.join(dir, `${ID}.jsonl`), cwd: '/w/app' })).rejects.toThrow(/agent data folder/);
    });

    it('copies the transcript into the folder of another worktree for a resume', async () => {
        const { pins } = create(async () => 'Name');
        const pin = await pins.pin({ transcript, cwd: '/w/app' });
        const resumed = await pins.prepareResume(pin.id, { cwd: '/w/other', repoPath: '/repo2', branch: 'main' });
        const copy = path.join(root, 'projects', '-w-other', `${ID}.jsonl`);
        expect(resumed).toMatchObject({ transcript: copy, cwd: '/w/other', repoPath: '/repo2', branch: 'main' });
        expect(await fs.readFile(copy, 'utf8')).toBe(`${LINES}\n`);
        expect(resumed.resumedAt).toBeGreaterThan(0);
        await settled(pins);
    });

    it('keeps a newer transcript in the target folder', async () => {
        const { pins } = create(async () => 'Name');
        const pin = await pins.pin({ transcript, cwd: '/w/app' });
        const copy = path.join(root, 'projects', '-w-other', `${ID}.jsonl`);
        await fs.mkdir(path.dirname(copy), { recursive: true });
        await fs.writeFile(copy, 'newer\n');
        const later = new Date(Date.now() + 60_000);
        await fs.utimes(copy, later, later);
        await pins.prepareResume(pin.id, { cwd: '/w/other' });
        expect(await fs.readFile(copy, 'utf8')).toBe('newer\n');
        await settled(pins);
    });

    /** Waits until the backup copy of the session has the content. */
    async function backedUp(pins: PinnedSessions, content = `${LINES}\n`) {
        await vi.waitFor(async () => expect(await fs.readFile(pins.backupPath(ID), 'utf8').catch(() => '')).toBe(content));
    }

    it('reports a transcript that Claude Code deleted when no backup copy exists', async () => {
        const { pins } = create(async () => 'Name');
        const pin = await pins.pin({ transcript, cwd: '/w/app' });
        await backedUp(pins);
        await fs.rm(transcript);
        await fs.rm(pins.backupPath(ID));
        await expect(pins.prepareResume(pin.id, { cwd: '/w/app' })).rejects.toThrow(/cannot find the transcript/);
        await settled(pins);
    });

    it('keeps a backup copy of a pinned transcript, and resumes from it when Claude Code deleted the transcript', async () => {
        const { pins } = create(async () => 'Name');
        const pin = await pins.pin({ transcript, cwd: '/w/app' });
        await backedUp(pins);
        await fs.rm(transcript);
        const resumed = await pins.prepareResume(pin.id, { cwd: '/w/app' });
        expect(resumed.transcript).toBe(transcript);
        expect(await fs.readFile(transcript, 'utf8')).toBe(`${LINES}\n`);
        await fs.rm(transcript);
        const other = await pins.prepareResume(pin.id, { cwd: '/w/other' });
        expect(other.transcript).toBe(path.join(root, 'projects', '-w-other', `${ID}.jsonl`));
        expect(await fs.readFile(other.transcript, 'utf8')).toBe(`${LINES}\n`);
        await settled(pins);
    });

    it('updates the backup copy when the session reports a new transcript state', async () => {
        const { pins } = create(async () => 'Name');
        await pins.pin({ transcript, cwd: '/w/app' });
        await backedUp(pins);
        await fs.appendFile(transcript, 'more\n');
        const later = new Date(Date.now() + 60_000);
        await fs.utimes(transcript, later, later);
        await pins.track(transcript);
        expect(await fs.readFile(pins.backupPath(ID), 'utf8')).toBe(`${LINES}\nmore\n`);
        await settled(pins);
    });

    it('deletes the backup copy when the pin goes, and the copies without a pin', async () => {
        const { pins } = create(async () => 'Name');
        const pin = await pins.pin({ transcript, cwd: '/w/app' });
        await backedUp(pins);
        await settled(pins);
        await pins.unpin(pin.id);
        await pins.backupAll();
        expect(await fs.readFile(pins.backupPath(ID), 'utf8')).toBe(`${LINES}\n`);
        await pins.remove(pin.id);
        await expect(fs.stat(pins.backupPath(ID))).rejects.toThrow();
        const orphan = path.join(path.dirname(pins.backupPath(ID)), 'old.jsonl');
        await fs.writeFile(orphan, 'x\n');
        await pins.backupAll();
        await expect(fs.stat(orphan)).rejects.toThrow();
    });

    it('follows the transcript of the session to a new folder', async () => {
        const { pins } = create(async () => 'Name');
        await pins.pin({ transcript, cwd: '/w/app' });
        const moved = path.join(root, 'projects', '-w-other', `${ID}.jsonl`);
        await pins.track(moved);
        expect((await pins.list())[0]?.transcript).toBe(moved);
        await settled(pins);
    });

    it('keeps an unpinned session for 3 days, then removes it', async () => {
        let now = Date.now();
        const { pins } = create(
            async () => 'Name',
            () => now
        );
        const pin = await pins.pin({ transcript, cwd: '/w/app' });
        await settled(pins);
        const unpinned = await pins.unpin(pin.id);
        expect(unpinned.unpinnedAt).toBe(now);
        expect(await pins.list()).toHaveLength(1);
        now += 3 * 24 * 60 * 60 * 1000 - 1;
        expect(await pins.list()).toHaveLength(1);
        now += 2;
        expect(await pins.list()).toHaveLength(0);
    });

    it('never removes a pin by its age', async () => {
        let now = Date.now();
        const { pins } = create(
            async () => 'Name',
            () => now
        );
        await pins.pin({ transcript, cwd: '/w/app' });
        await settled(pins);
        now += 365 * 24 * 60 * 60 * 1000;
        expect(await pins.list()).toHaveLength(1);
    });

    it('pins an unpinned session again with its name', async () => {
        const { pins } = create(async () => 'Name');
        const pin = await pins.pin({ transcript, cwd: '/w/app' });
        await settled(pins);
        await pins.rename(pin.id, 'My name');
        await pins.unpin(pin.id);
        const restored = await pins.restore(pin.id);
        expect(restored.unpinnedAt).toBeUndefined();
        expect(restored.name).toBe('My name');
        await pins.unpin(pin.id);
        const again = await pins.pin({ transcript, cwd: '/w/app' });
        expect(again).toMatchObject({ id: pin.id, name: 'My name' });
        expect(again.unpinnedAt).toBeUndefined();
    });

    it('keeps the tags of a session with or without a pin', async () => {
        const { pins, changes } = create(async () => 'Name');
        expect(await pins.setTags(ID, ['#billing', 'Billing', 'bug fix'])).toEqual(['billing', 'bug-fix']);
        expect((await pins.state()).tags).toEqual({ [ID]: ['billing', 'bug-fix'] });
        expect(changes.at(-1)?.tags[ID]).toEqual(['billing', 'bug-fix']);
        const pin = await pins.pin({ transcript, cwd: '/w/app' });
        await settled(pins);
        await pins.remove(pin.id);
        expect((await pins.state()).tags[ID]).toEqual(['billing', 'bug-fix']);
        await pins.setTags(ID, []);
        expect((await pins.state()).tags).toEqual({});
    });

    it('refuses tags for a session ID that is not valid', async () => {
        const { pins } = create(async () => 'Name');
        await expect(pins.setTags('../x', ['a'])).rejects.toThrow(/not valid/);
    });
});
