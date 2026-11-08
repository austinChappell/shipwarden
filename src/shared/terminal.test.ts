import { describe, expect, it } from 'vitest';
import { runsAgent } from './terminal';

describe('runsAgent', () => {
    it('counts a running agent tab', () => {
        expect(runsAgent({ isAgent: true, exited: false })).toBe(true);
        expect(runsAgent({ isAgent: true, exited: true, agentState: 'exited' })).toBe(false);
    });

    it('counts a shell tab while an agent in it reports its state', () => {
        expect(runsAgent({ isAgent: false, exited: false })).toBe(false);
        expect(runsAgent({ isAgent: false, exited: false, agentState: 'working' })).toBe(true);
        expect(runsAgent({ isAgent: false, exited: false, agentState: 'exited' })).toBe(false);
    });
});
