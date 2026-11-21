import { describe, expect, it, vi } from 'vitest';
import { newCompareGroup } from '@shared/agent-compare';
import type { NewStatsEvent } from '@shared/stats';
import type { TerminalSession } from '@shared/terminal';
import { StatsRecorder } from './stats-recorder';
import type { StatsStore } from './stats-store';

const session: TerminalSession = {
    id: 's1',
    title: 'Claude Code',
    cwd: '/w/a',
    worktreePath: '/w/a',
    isAgent: true,
    exited: false,
    agentModel: 'claude-sonnet-4-5',
    agentTranscript: '/u/.claude/projects/p/s1.jsonl'
};

function setup() {
    const events: NewStatsEvent[] = [];
    const store = { append: (event: NewStatsEvent) => events.push(event) } as unknown as StatsStore;
    const repoOf = vi.fn(async () => ({ owner: 'acme', name: 'api' }));
    const recorder = new StatsRecorder({
        store,
        session: async id => (id === session.id ? session : undefined),
        repoOf,
        tokens: async () => 1200,
        programOf: async name => (name === 'Claude Code' ? 'claude' : undefined),
        now: () => 500
    });
    return { events, recorder, repoOf };
}

describe('StatsRecorder', () => {
    it('writes one line for each change of state, with the agent, the repository, and the tokens', async () => {
        const { events, recorder, repoOf } = setup();
        recorder.agentState('s1', { state: 'working', at: 100 });
        recorder.agentState('s1', { state: 'working', at: 100, message: 'Running npm test' });
        recorder.agentState('s1', { state: 'waiting', waitFor: 'permission', at: 200 });
        recorder.agentState('s1', { state: 'waiting', waitFor: 'question', at: 300 });
        await vi.waitFor(() => expect(events).toHaveLength(3));
        expect(events[0]).toEqual({
            type: 'state',
            at: 100,
            session: 's1',
            worktree: '/w/a',
            repo: 'acme/api',
            program: 'claude',
            agent: 'Claude Code',
            model: 'claude-sonnet-4-5',
            state: 'working',
            transcript: '/u/.claude/projects/p/s1.jsonl',
            tokens: 1200
        });
        expect(events[1]).toMatchObject({ state: 'waiting', waitFor: 'permission', reason: 'permission' });
        expect(events[2]).toMatchObject({ state: 'waiting', waitFor: 'question', reason: 'question' });
        // The repository of a worktree is read one time.
        expect(repoOf).toHaveBeenCalledTimes(1);
    });

    it('writes the merge with the repository and the pull request URL', async () => {
        const { events, recorder } = setup();
        recorder.merged('/w/a', 7, 'squash');
        recorder.merged({ owner: 'acme', name: 'web' }, 9, 'merge');
        await vi.waitFor(() => expect(events).toHaveLength(2));
        expect(events).toContainEqual({
            type: 'merge',
            at: 500,
            worktree: '/w/a',
            repo: 'acme/api',
            url: 'https://github.com/acme/api/pull/7',
            number: 7,
            method: 'squash'
        });
        expect(events).toContainEqual({ type: 'merge', at: 500, repo: 'acme/web', url: 'https://github.com/acme/web/pull/9', number: 9, method: 'merge' });
    });

    it('writes the winner of a comparison', async () => {
        const { events, recorder } = setup();
        const runs = [
            { agentId: 'claude', agentName: 'Claude Code', branch: 'fix-claude', worktreePath: '/w/a' },
            { agentId: 'codex', agentName: 'Codex', branch: 'fix-codex', worktreePath: '/w/b' }
        ];
        const group = newCompareGroup('/code/api', { connectionId: 'c', pluginId: 'p', taskId: 't', key: 'ENG-1', title: 'Fix' }, runs, 1);
        recorder.kept(group);
        recorder.kept({ ...group, keptPath: '/w/b' });
        await vi.waitFor(() => expect(events).toHaveLength(1));
        expect(events[0]).toMatchObject({
            type: 'compare',
            compare: group.id,
            repo: 'acme/api',
            task: 'ENG-1 Fix',
            winner: { agentId: 'codex', agentName: 'Codex', worktree: '/w/b' }
        });
    });

    it('writes a start with the repository and the agent program', async () => {
        const { events, recorder } = setup();
        recorder.started({ worktree: '/w/a', agent: 'Claude Code', task: 'ENG-1 Fix' });
        await vi.waitFor(() => expect(events).toHaveLength(1));
        expect(events[0]).toEqual({ type: 'start', at: 500, worktree: '/w/a', repo: 'acme/api', program: 'claude', agent: 'Claude Code', task: 'ENG-1 Fix' });
    });

    it('writes a CI line only when the state or the commit changes', async () => {
        const { events, recorder } = setup();
        recorder.ci({ worktree: '/w/a', number: 7, sha: 'a1', ci: 'running' });
        recorder.ci({ worktree: '/w/a', number: 7, sha: 'a1', ci: 'running' });
        recorder.ci({ worktree: '/w/a', number: 7, sha: 'a1', ci: 'failed' });
        recorder.ci({ worktree: '/w/a', number: 7, sha: 'a2', ci: 'failed' });
        await vi.waitFor(() => expect(events).toHaveLength(3));
        expect(events[0]).toEqual({ type: 'ci', at: 500, worktree: '/w/a', repo: 'acme/api', number: 7, sha: 'a1', ci: 'running' });
        expect(events.map(event => (event.type === 'ci' ? `${event.sha}:${event.ci}` : ''))).toEqual(['a1:running', 'a1:failed', 'a2:failed']);
    });
});
