import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PinnedSession } from '@shared/pinned-sessions';
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

    function create(ask: (pin: PinnedSession, prompt: string) => Promise<string>) {
        const changes: PinnedSession[][] = [];
        const pins = new PinnedSessions({ file: path.join(dir, 'pins.json'), onChanged: list => changes.push(list), ask, roots: () => [root] });
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
        expect(changes.at(-1)?.[0]?.name).toBe('Fix flaky login test');
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

    it('reports a transcript that Claude Code deleted', async () => {
        const { pins } = create(async () => 'Name');
        const pin = await pins.pin({ transcript, cwd: '/w/app' });
        await fs.rm(transcript);
        await expect(pins.prepareResume(pin.id, { cwd: '/w/app' })).rejects.toThrow(/cannot find the transcript/);
        await settled(pins);
    });

    it('follows the transcript of the session to a new folder', async () => {
        const { pins } = create(async () => 'Name');
        await pins.pin({ transcript, cwd: '/w/app' });
        const moved = path.join(root, 'projects', '-w-other', `${ID}.jsonl`);
        await pins.track(moved);
        expect((await pins.list())[0]?.transcript).toBe(moved);
        await settled(pins);
    });
});
