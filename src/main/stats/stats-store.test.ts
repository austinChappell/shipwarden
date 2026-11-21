import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STATS_RETENTION_MS } from '@shared/stats';
import { StatsStore } from './stats-store';

const DAY = 24 * 60 * 60 * 1000;

describe('StatsStore', () => {
    let dir: string;
    let file: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-stats-'));
        file = path.join(dir, 'data', 'agent-stats.jsonl');
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('appends one line for each event and reads the events back in order', async () => {
        const store = new StatsStore(file);
        store.append({ type: 'state', at: 100, session: 's1', agent: 'Claude Code', state: 'working' });
        store.append({ type: 'state', at: 200, session: 's1', state: 'waiting', waitFor: 'permission', reason: 'permission' });
        store.append({ type: 'merge', at: 300, repo: 'acme/api', number: 7, url: 'https://github.com/acme/api/pull/7', method: 'merge' });
        store.append({
            type: 'compare',
            at: 400,
            compare: 'c1',
            repoPath: '/code/api',
            task: 'Fix the login',
            winner: { agentId: 'codex', agentName: 'Codex', worktree: '/w/b' },
            runs: [
                { agentId: 'claude', agentName: 'Claude Code', worktree: '/w/a' },
                { agentId: 'codex', agentName: 'Codex', worktree: '/w/b' }
            ]
        });
        await store.flush();

        const text = await fs.readFile(file, 'utf8');
        expect(text.split('\n')).toHaveLength(5);
        expect(JSON.parse(text.split('\n')[0])).toEqual({ v: 1, type: 'state', at: 100, session: 's1', agent: 'Claude Code', state: 'working' });

        const events = await new StatsStore(file).read();
        expect(events.map(event => event.type)).toEqual(['state', 'state', 'merge', 'compare']);
        expect(events[1]).toMatchObject({ waitFor: 'permission', reason: 'permission' });
        expect(await new StatsStore(file).read(250)).toHaveLength(2);
    });

    it('reads no events when the file does not exist', async () => {
        expect(await new StatsStore(file).read()).toEqual([]);
    });

    it('ignores lines that are not valid events', async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, '{"v":1,"type":"state","at":1,"session":"s","state":"done"}\nnot json\n{"v":99,"type":"state","at":2}\n{"v":1,"type":"mer');
        const events = await new StatsStore(file).read();
        expect(events).toEqual([{ v: 1, type: 'state', at: 1, session: 's', state: 'done' }]);
    });

    it('removes the lines older than 90 days and keeps the file when nothing is old', async () => {
        const now = 200 * DAY;
        const store = new StatsStore(file, () => now);
        store.append({ type: 'state', at: now - STATS_RETENTION_MS - 1, session: 'old', state: 'done' });
        store.append({ type: 'state', at: now - STATS_RETENTION_MS, session: 'edge', state: 'done' });
        store.append({ type: 'state', at: now - DAY, session: 'new', state: 'done' });
        await store.prune();
        expect((await store.read()).map(event => (event.type === 'state' ? event.session : ''))).toEqual(['edge', 'new']);

        const before = (await fs.stat(file)).mtimeMs;
        await store.prune();
        expect((await fs.stat(file)).mtimeMs).toBe(before);
        expect(await fs.readdir(path.dirname(file))).toEqual(['agent-stats.jsonl']);
    });

    it('does not throw when a write fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        // A folder with the name of the file makes each write fail.
        await fs.mkdir(file, { recursive: true });
        const store = new StatsStore(file);
        store.append({ type: 'state', at: 1, session: 's', state: 'done' });
        store.append({ type: 'state', at: 2, session: 's', state: 'working' });
        await expect(store.flush()).resolves.toBeUndefined();
        await expect(store.prune()).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
});
