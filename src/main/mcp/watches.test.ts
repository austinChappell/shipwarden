import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpWatches, normalizeWatches, watchEventsOf } from './watches';

const folders: string[] = [];
function setup(onChanged = vi.fn()) {
    const folder = mkdtempSync(join(tmpdir(), 'mcp-watches-'));
    folders.push(folder);
    const file = join(folder, 'watches.json');
    return { file, onChanged, watches: new McpWatches(file, onChanged, () => 1000) };
}

afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));

describe('McpWatches', () => {
    it('adds a watch, replaces the watch of the same session and worktree, and keeps the others', async () => {
        const { watches, onChanged } = setup();
        const first = await watches.add({ worktree: '/w/a', sessionId: 's1', number: 7, events: ['ci.failed'] });
        await watches.add({ worktree: '/w/b', sessionId: 's1', number: 8, events: ['pr.comment'] });
        const second = await watches.add({ worktree: '/w/a', sessionId: 's1', number: 7, events: ['pr.conflict'] });
        expect(second.id).not.toBe(first.id);
        expect((await watches.list()).map(watch => [watch.worktree, watch.events])).toEqual([
            ['/w/b', ['pr.comment']],
            ['/w/a', ['pr.conflict']]
        ]);
        expect(onChanged).toHaveBeenCalledTimes(3);
        expect(second.createdAt).toBe(1000);
    });

    it('removes the watches that match, and keeps them after a restart', async () => {
        const { watches, file } = setup();
        await watches.add({ worktree: '/w/a', sessionId: 's1', number: 7, events: ['ci.failed'] });
        await watches.add({ worktree: '/w/b', sessionId: 's2', number: 8, events: ['ci.failed'] });
        const removed = await watches.remove(watch => watch.sessionId === 's1');
        expect(removed.map(watch => watch.worktree)).toEqual(['/w/a']);
        expect((await new McpWatches(file).list()).map(watch => watch.worktree)).toEqual(['/w/b']);
    });

    it('does not write when nothing matches', async () => {
        const { watches, onChanged } = setup();
        expect(await watches.remove(() => true)).toEqual([]);
        expect(onChanged).not.toHaveBeenCalled();
    });
});

describe('watchEventsOf', () => {
    it('keeps the known events in their order, and gives all events for a wrong value', () => {
        expect(watchEventsOf(['pr.comment', 'ci.failed', 'pr.comment', 'x'])).toEqual(['ci.failed', 'pr.comment']);
        expect(watchEventsOf(['x'])).toEqual(['ci.failed', 'pr.conflict', 'pr.comment']);
        expect(watchEventsOf(undefined)).toEqual(['ci.failed', 'pr.conflict', 'pr.comment']);
    });
});

describe('normalizeWatches', () => {
    it('drops the broken items', () => {
        expect(normalizeWatches('x')).toEqual([]);
        expect(normalizeWatches([null, { id: 'w' }, { id: 'w', worktree: '/a', sessionId: 's', number: 1, createdAt: 2, events: [] }])).toEqual([
            { id: 'w', worktree: '/a', sessionId: 's', number: 1, createdAt: 2, events: ['ci.failed', 'pr.conflict', 'pr.comment'] }
        ]);
    });
});
