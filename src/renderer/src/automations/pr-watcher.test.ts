import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationEvent } from '@shared/automations';
import type { McpWatch } from '@shared/mcp';
import { PullRequestWatcher, TAB_CLOSED_ERROR, WATCH_MAX_TRIES } from './pr-watcher';

const watch: McpWatch = { id: 'w1', worktree: '/w/a', sessionId: 's1', events: ['ci.failed'], number: 7, createdAt: 1 };
const failed = { trigger: 'ci.failed', key: 'ci:1', target: 't', label: 'l', at: 1, worktreePath: '/w/a', pr: { number: 7, url: 'u' } } as AutomationEvent;

function setup(send = vi.fn(async () => undefined)) {
    const end = vi.fn(async () => undefined);
    const watcher = new PullRequestWatcher({ send, end }, 1000);
    watcher.setWatches([watch]);
    return { watcher, send, end };
}

afterEach(() => vi.useRealTimers());

describe('PullRequestWatcher', () => {
    it('sends each event one time to the session of the watch', async () => {
        const { watcher, send } = setup();
        expect(watcher.wants('ci.failed')).toBe(true);
        expect(watcher.wants('pr.comment')).toBe(false);
        watcher.onEvent(failed);
        watcher.onEvent(failed);
        await Promise.resolve();
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith(watch, expect.stringContaining('A check failed on pull request #7'));
    });

    it('ends the watch when the agent tab closed', async () => {
        const { watcher, end } = setup(vi.fn(async () => Promise.reject(new Error(TAB_CLOSED_ERROR))));
        watcher.onEvent(failed);
        await vi.waitFor(() => expect(end).toHaveBeenCalledWith(watch));
        expect(watcher.active()).toBe(false);
    });

    it('tries a message again later, for example while the agent asks a question', async () => {
        vi.useFakeTimers();
        const send = vi.fn(async () => Promise.reject(new Error('The agent is asking a question.')));
        const { watcher } = setup(send);
        watcher.onEvent(failed);
        for (let index = 0; index < WATCH_MAX_TRIES + 2; index++) await vi.advanceTimersByTimeAsync(1000);
        expect(send).toHaveBeenCalledTimes(WATCH_MAX_TRIES);
    });

    it('ends the watch of a pull request that left the open list, with a last message', async () => {
        const { watcher, send, end } = setup();
        watcher.onClosed('/w/a', 8);
        expect(end).not.toHaveBeenCalled();
        watcher.onClosed('/w/a', 7);
        await Promise.resolve();
        expect(send).toHaveBeenCalledWith(watch, expect.stringContaining('#7 is not open anymore'));
        expect(end).toHaveBeenCalledWith(watch);
        expect(watcher.active()).toBe(false);
    });
});
