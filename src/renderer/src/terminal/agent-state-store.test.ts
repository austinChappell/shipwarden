import { describe, expect, it, vi } from 'vitest';
import type { AgentUpdate } from '@shared/agents';
import { AgentStateStore } from './agent-state-store';

const working: AgentUpdate = { state: 'working', message: 'Edit src/a.ts', prompt: 'Fix the bug', at: 1000 };

describe('AgentStateStore', () => {
    it('notifies the listeners and gives a new snapshot when a state changes', () => {
        const store = new AgentStateStore();
        const listener = vi.fn();
        store.subscribe(listener);
        const before = store.getSnapshot();

        store.set('a', working);

        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getSnapshot()).not.toBe(before);
        expect(store.getSnapshot().get('a')).toEqual(working);
    });

    it('ignores an update that changes nothing, so the views do not render again', () => {
        const store = new AgentStateStore();
        store.set('a', working);
        const listener = vi.fn();
        store.subscribe(listener);
        const before = store.getSnapshot();

        store.set('a', { ...working });

        expect(listener).not.toHaveBeenCalled();
        expect(store.getSnapshot()).toBe(before);
    });

    it('notifies the listeners when only the message changes', () => {
        const store = new AgentStateStore();
        store.set('a', working);
        const listener = vi.fn();
        store.subscribe(listener);

        store.set('a', { ...working, message: 'Run the tests' });

        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getSnapshot().get('a')?.message).toBe('Run the tests');
    });

    it('forgets a closed session, and a delete of an unknown session changes nothing', () => {
        const store = new AgentStateStore();
        store.set('a', working);
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);

        store.delete('unknown');
        expect(listener).not.toHaveBeenCalled();

        store.delete('a');
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getSnapshot().has('a')).toBe(false);

        unsubscribe();
        store.set('b', working);
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
