import { describe, expect, it } from 'vitest';
import {
    agentCountError,
    compareBranches,
    compareRunState,
    groupsOfTask,
    MAX_COMPARE_AGENTS,
    newCompareGroup,
    normalizeCompareGroup,
    removeRunsDialog,
    runsToRemove,
    withGroup,
    withKeptRun,
    type CompareRun,
    type CompareTask
} from './agent-compare';

const task: CompareTask = { connectionId: 'c1', pluginId: 'local', taskId: 't1', key: 'ENG-1', title: 'Fix the login' };

function run(agentId: string, worktreePath: string): CompareRun {
    return { agentId, agentName: agentId, branch: `b-${agentId}`, worktreePath };
}

describe('compareBranches', () => {
    it('adds the agent to the end of the task branch', () => {
        expect(
            compareBranches('jsmith/ENG-1-fix-login', [
                { id: 'claude', name: 'Claude Code' },
                { id: 'codex', name: 'Codex' }
            ])
        ).toEqual(['jsmith/ENG-1-fix-login-claude', 'jsmith/ENG-1-fix-login-codex']);
    });

    it('gives a number to agents with the same end part', () => {
        expect(
            compareBranches('fix', [
                { id: 'Claude', name: 'A' },
                { id: 'claude', name: 'B' },
                { id: 'claude', name: 'C' }
            ])
        ).toEqual(['fix-claude', 'fix-claude-2', 'fix-claude-3']);
    });

    it('uses the name when the ID has no letters or digits, and makes a valid branch', () => {
        expect(compareBranches('fix.', [{ id: '…', name: 'My Agent' }])).toEqual(['fix.-my-agent']);
        expect(compareBranches('a b', [{ id: '', name: '' }])).toEqual(['a-b-agent']);
    });
});

describe('agentCountError', () => {
    it('accepts 2 to 4 agents', () => {
        expect(agentCountError(1)).toMatch(/at least 2/);
        expect(agentCountError(2)).toBeUndefined();
        expect(agentCountError(MAX_COMPARE_AGENTS)).toBeUndefined();
        expect(agentCountError(MAX_COMPARE_AGENTS + 1)).toMatch(/at most 4/);
    });
});

describe('run states', () => {
    const group = newCompareGroup('/repo', task, [run('claude', '/w/a'), run('codex', '/w/b'), run('gemini', '/w/c')], 100);

    it('shows all runs as active before a keep, and a missing worktree as removed', () => {
        const existing = new Set(['/w/a', '/w/b']);
        expect(group.runs.map(item => compareRunState(group, item, existing))).toEqual(['active', 'active', 'removed']);
        expect(runsToRemove(group, existing)).toEqual([]);
    });

    it('keeps one run and offers the others that still exist for removal', () => {
        const kept = withKeptRun(group, '/w/b', 200);
        expect(kept.updatedAt).toBe(200);
        const existing = new Set(['/w/a', '/w/b']);
        expect(kept.runs.map(item => compareRunState(kept, item, existing))).toEqual(['other', 'kept', 'removed']);
        expect(runsToRemove(kept, existing).map(item => item.worktreePath)).toEqual(['/w/a']);
    });

    it('refuses a worktree that is not a run', () => {
        expect(() => withKeptRun(group, '/w/x', 200)).toThrow(/no run/);
    });
});

describe('group lists', () => {
    it('finds the groups of a task, the newest first', () => {
        const first = newCompareGroup('/repo', task, [run('claude', '/w/a')], 100);
        const second = newCompareGroup('/repo', task, [run('codex', '/w/b')], 300);
        const other = newCompareGroup('/repo', { ...task, taskId: 't2' }, [run('codex', '/w/c')], 200);
        expect(groupsOfTask([first, other, second], 'c1', 't1').map(group => group.id)).toEqual([second.id, first.id]);
    });

    it('replaces a group with the same ID and puts the newest change first', () => {
        const first = newCompareGroup('/repo', task, [run('claude', '/w/a')], 100);
        const second = newCompareGroup('/repo', task, [run('codex', '/w/b')], 200);
        const changed = { ...first, updatedAt: 300 };
        expect(withGroup([second, first], changed).map(group => group.updatedAt)).toEqual([300, 200]);
    });
});

describe('normalizeCompareGroup', () => {
    it('keeps a valid group', () => {
        const group = withKeptRun(newCompareGroup('/repo', task, [run('claude', '/w/a'), run('codex', '/w/b')], 100), '/w/a', 150);
        expect(normalizeCompareGroup(JSON.parse(JSON.stringify(group)))).toEqual(group);
    });

    it('refuses a group without an ID, a task, or runs', () => {
        expect(normalizeCompareGroup({ repoPath: '/repo', task, runs: [run('a', '/w/a')] })).toBeUndefined();
        expect(normalizeCompareGroup({ id: 'x', repoPath: '/repo', runs: [run('a', '/w/a')] })).toBeUndefined();
        expect(normalizeCompareGroup({ id: 'x', repoPath: '/repo', task, runs: [] })).toBeUndefined();
        expect(normalizeCompareGroup('text')).toBeUndefined();
    });

    it('removes bad and repeated runs, and a kept path that is not a run', () => {
        const group = normalizeCompareGroup({
            id: 'x',
            repoPath: '/repo',
            task,
            runs: [run('a', '/w/a'), { agentId: 'b' }, run('c', '/w/a'), run('d', '/w/d')],
            keptPath: '/w/zzz',
            createdAt: 5,
            updatedAt: 6
        });
        expect(group?.runs.map(item => item.agentId)).toEqual(['a', 'd']);
        expect(group?.keptPath).toBeUndefined();
    });
});

describe('removeRunsDialog', () => {
    it('names each run and says that the branches stay', () => {
        const one = removeRunsDialog([run('codex', '/w/b')], false);
        expect(one.title).toBe('Remove the worktree of the other agent?');
        expect(one.message).toContain('codex (b-codex)');
        expect(one.message).toContain('Git keeps the branches.');
        expect(one.confirmLabel).toBe('Remove worktree');
        const two = removeRunsDialog([run('codex', '/w/b'), run('gemini', '/w/c')], true);
        expect(two.title).toBe('Remove the 2 worktrees of the other agents?');
        expect(two.message).toContain('teardown script');
        expect(two.confirmLabel).toBe('Remove worktrees');
    });
});
