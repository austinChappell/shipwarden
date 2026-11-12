import { describe, expect, it } from 'vitest';
import { canShowChat, showsChat } from './agent-view-store';

const agent = { isAgent: true, exited: false, agentState: 'working' as const, agentTranscript: '/home/.claude/projects/x/s.jsonl' };

describe('agent tab view', () => {
    it('shows the chat only for an agent tab with a transcript', () => {
        expect(canShowChat(agent, false)).toBe(true);
        expect(canShowChat({ ...agent, agentTranscript: undefined }, false)).toBe(false);
        expect(canShowChat({ ...agent, isAgent: false }, true)).toBe(false);
        expect(canShowChat({ ...agent, exited: true }, true)).toBe(false);
        expect(canShowChat({ ...agent, agentState: 'exited' }, true)).toBe(false);
    });

    it('shows the chat of a Claude Code tab from its start, before the transcript', () => {
        const starting = { ...agent, agentState: 'starting' as const, agentTranscript: undefined };
        expect(canShowChat(starting, true)).toBe(true);
        expect(canShowChat(starting, false)).toBe(false);
        expect(canShowChat({ ...starting, agentState: undefined }, true)).toBe(false);
    });

    it('uses the setting when the user did not select a view', () => {
        expect(showsChat(agent, undefined, true, true)).toBe(true);
        expect(showsChat(agent, undefined, false, true)).toBe(false);
        expect(showsChat(agent, 'chat', false, true)).toBe(true);
        expect(showsChat(agent, 'terminal', true, true)).toBe(false);
    });

    it('shows the terminal for an answer only while the agent waits', () => {
        expect(showsChat({ ...agent, agentState: 'waiting' }, 'answer', true, true)).toBe(false);
        expect(showsChat({ ...agent, agentState: 'starting' }, 'answer', true, true)).toBe(false);
        expect(showsChat({ ...agent, agentState: 'idle' }, 'answer', true, true)).toBe(true);
        expect(showsChat({ ...agent, agentState: 'working' }, 'answer', true, true)).toBe(true);
    });
});
