import { describe, expect, it } from 'vitest';
import {
    computeStats,
    formatShare,
    parseStatsCi,
    parseStatsStart,
    statsCiChange,
    linesToKeep,
    MAX_STATE_MS,
    median,
    parseStatsLine,
    rate,
    STATS_LOG_VERSION,
    type StatsEvent,
    statsLine,
    statsWindowStart,
    UNKNOWN_AGENT,
    UNKNOWN_MODEL
} from './stats';

describe('stats log lines', () => {
    it('writes an event as one JSON line with the version', () => {
        expect(statsLine({ type: 'merge', at: 5, number: 7, url: undefined })).toBe('{"v":1,"type":"merge","at":5,"number":7}\n');
    });

    it('reads only valid events', () => {
        expect(parseStatsLine(statsLine({ type: 'state', at: 1, session: 's', state: 'done' }))).toEqual({
            v: 1,
            type: 'state',
            at: 1,
            session: 's',
            state: 'done'
        });
        expect(parseStatsLine('')).toBeUndefined();
        expect(parseStatsLine('{"v":1,"type":"state","at":1')).toBeUndefined();
        expect(parseStatsLine('{"v":2,"type":"merge","at":1,"number":1}')).toBeUndefined();
        expect(parseStatsLine('{"v":1,"type":"merge","at":1}')).toBeUndefined();
        expect(parseStatsLine('{"v":1,"type":"compare","at":1,"compare":"c","runs":[]}')).toBeUndefined();
        expect(parseStatsLine('{"v":1,"type":"other","at":1}')).toBeUndefined();
        expect(parseStatsLine('[1]')).toBeUndefined();
        expect(parseStatsLine('{"v":1,"type":"start","at":1,"worktree":"/w/a","agent":"Codex"}')).toMatchObject({ type: 'start', agent: 'Codex' });
        expect(parseStatsLine('{"v":1,"type":"start","at":1}')).toBeUndefined();
        expect(parseStatsLine('{"v":1,"type":"ci","at":1,"worktree":"/w/a","number":7,"sha":"abc","ci":"failed"}')).toMatchObject({ type: 'ci', ci: 'failed' });
        expect(parseStatsLine('{"v":1,"type":"ci","at":1,"worktree":"/w/a","number":7,"sha":"abc","ci":"none"}')).toBeUndefined();
        expect(parseStatsLine('{"v":1,"type":"ci","at":1,"worktree":"/w/a","sha":"abc","ci":"passed"}')).toBeUndefined();
    });

    it('keeps the lines at or after the time', () => {
        const text = ['{"v":1,"type":"merge","at":1,"number":1}', 'bad', '{"v":1,"type":"merge","at":5,"number":2}', ''].join('\n');
        expect(linesToKeep(text, 5)).toEqual(['{"v":1,"type":"merge","at":5,"number":2}']);
    });
});

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 100 * DAY;
const v = STATS_LOG_VERSION;

function state(at: number, session: string, value: string, extra: Partial<StatsEvent> = {}): StatsEvent {
    return { v, type: 'state', at, session, worktree: '/w/a', agent: 'Claude Code', state: value, ...extra } as StatsEvent;
}

describe('median and rate', () => {
    it('gives the median of odd and even counts, and undefined for no values', () => {
        expect(median([])).toBeUndefined();
        expect(median([5])).toBe(5);
        expect(median([9, 1, 5])).toBe(5);
        expect(median([4, 1, 3, 2])).toBe(2.5);
    });

    it('gives undefined for a rate of nothing', () => {
        expect(rate(0, 0)).toBeUndefined();
        expect(rate(0, 4)).toBe(0);
        expect(rate(1, 4)).toBe(0.25);
    });

    it('gives the start of the time range', () => {
        expect(statsWindowStart(NOW, 7)).toBe(NOW - 7 * DAY);
    });
});

describe('computeStats', () => {
    it('gives empty data for an empty log', () => {
        const stats = computeStats([], { now: NOW, days: 30, groupBy: 'agent' });
        expect(stats.empty).toBe(true);
        expect(stats.rows).toEqual([]);
        expect(stats.total).toMatchObject({ merged: 0, agentMs: 0, firstPushes: 0, compareWins: 0 });
        expect(stats.total.tokensPerPr).toBeUndefined();
        expect(stats.total.mergeMs).toBeUndefined();
        expect(stats.total.needsInputShare).toBeUndefined();
        expect(stats.total.blockedCiShare).toBeUndefined();
        expect(stats.total.firstPushFailRate).toBeUndefined();
    });

    it('gives the tokens and the time to merge of each merged pull request', () => {
        const t = NOW - 2 * DAY;
        const events: StatsEvent[] = [
            { v, type: 'start', at: t, worktree: '/w/a', agent: 'Claude Code', task: 'ENG-1 Fix' },
            state(t + MIN, 's1', 'working', { model: 'claude-sonnet-4-5', tokens: 100 }),
            state(t + 2 * HOUR, 's1', 'done', { tokens: 5000 }),
            { v, type: 'merge', at: t + 3 * HOUR, worktree: '/w/a', repo: 'acme/api', number: 7 },
            // A second pull request in the same worktree. Its tokens start after the first merge.
            state(t + 4 * HOUR, 's1', 'working', { tokens: 6000 }),
            state(t + 5 * HOUR, 's1', 'done', { tokens: 8000 }),
            { v, type: 'merge', at: t + 6 * HOUR, worktree: '/w/a', repo: 'acme/api', number: 8 }
        ];
        const stats = computeStats(events, { now: NOW, days: 7, groupBy: 'agent' });
        expect(stats.rows).toHaveLength(1);
        const row = stats.rows[0];
        expect(row).toMatchObject({ label: 'Claude Code', merged: 2, tokenPrs: 2, timedPrs: 2 });
        // 5000 tokens for the first pull request, 8000 - 5000 for the second.
        expect(row.tokensPerPr).toBe(4000);
        // 3 hours from the start line, and 2 hours from the first state after the first merge.
        expect(row.mergeMs).toBe(2.5 * HOUR);
        expect(computeStats(events, { now: NOW, days: 7, groupBy: 'model' }).rows[0].label).toBe('claude-sonnet-4-5');
    });

    it('shows no token data for an agent without a token count', () => {
        const t = NOW - DAY;
        const events: StatsEvent[] = [
            { v, type: 'start', at: t, worktree: '/w/b', agent: 'Codex' },
            { v, type: 'merge', at: t + HOUR, worktree: '/w/b', number: 9 }
        ];
        const [row] = computeStats(events, { now: NOW, days: 7, groupBy: 'agent' }).rows;
        expect(row).toMatchObject({ label: 'Codex', merged: 1, tokenPrs: 0, mergeMs: HOUR });
        expect(row.tokensPerPr).toBeUndefined();
        expect(row.needsInputShare).toBeUndefined();
        const [byModel] = computeStats(events, { now: NOW, days: 7, groupBy: 'model' }).rows;
        expect(byModel.label).toBe(UNKNOWN_MODEL);
    });

    it('finds the worktree of a merge from the Review page in the CI lines', () => {
        const t = NOW - DAY;
        const events: StatsEvent[] = [
            state(t, 's1', 'working'),
            { v, type: 'ci', at: t + HOUR, worktree: '/w/a', repo: 'acme/api', number: 7, sha: 'a1', ci: 'passed' },
            { v, type: 'merge', at: t + 2 * HOUR, repo: 'acme/api', number: 7 },
            { v, type: 'merge', at: t + 2 * HOUR, repo: 'acme/web', number: 3 }
        ];
        const stats = computeStats(events, { now: NOW, days: 7, groupBy: 'agent' });
        expect(stats.total.merged).toBe(2);
        expect(stats.rows.find(row => row.label === 'Claude Code')).toMatchObject({ merged: 1, mergeMs: 2 * HOUR });
        expect(stats.rows.find(row => row.label === UNKNOWN_AGENT)).toMatchObject({ merged: 1, timedPrs: 0 });
    });

    it('gives the part of the time in "needs input" and in "blocked on CI"', () => {
        const t = NOW - DAY;
        const events: StatsEvent[] = [
            state(t, 's1', 'working'),
            state(t + 6 * HOUR, 's1', 'waiting', { waitFor: 'permission' }),
            state(t + 7 * HOUR, 's1', 'done'),
            { v, type: 'ci', at: t + 7 * HOUR, worktree: '/w/a', number: 7, sha: 'a1', ci: 'running' },
            { v, type: 'ci', at: t + 9 * HOUR, worktree: '/w/a', number: 7, sha: 'a1', ci: 'passed' },
            { v, type: 'merge', at: t + 10 * HOUR, worktree: '/w/a', number: 7 }
        ];
        const { total } = computeStats(events, { now: NOW, days: 7, groupBy: 'agent' });
        // 6 hours working, 1 hour waiting, 2 hours blocked on CI, 1 hour done with green CI. The last state ends at the merge.
        expect(total.agentMs).toBe(10 * HOUR);
        expect(total.needsInputMs).toBe(HOUR);
        expect(total.blockedCiMs).toBe(2 * HOUR);
        expect(total.needsInputShare).toBeCloseTo(0.1);
        expect(total.blockedCiShare).toBeCloseTo(0.2);
    });

    it('cuts a state at the start of the range, at now, and at the longest state time', () => {
        const events: StatsEvent[] = [
            state(NOW - 8 * DAY, 's1', 'waiting', { waitFor: 'question' }),
            state(NOW - 3 * HOUR, 's2', 'working'),
            state(NOW - HOUR, 's2', 'exited')
        ];
        const { total } = computeStats(events, { now: NOW, days: 7, groupBy: 'agent' });
        // The first state ends after MAX_STATE_MS, before the range. Only the 2 working hours count. An exited agent counts no time.
        expect(MAX_STATE_MS).toBeLessThan(DAY);
        expect(total.agentMs).toBe(2 * HOUR);
        expect(total.needsInputMs).toBe(0);
    });

    it('gives the CI failure rate of the first push', () => {
        const t = NOW - DAY;
        const events: StatsEvent[] = [
            state(t, 's1', 'working', { worktree: '/w/a' }),
            state(t, 's2', 'working', { worktree: '/w/b', agent: 'Codex' }),
            // First push of /w/a fails. A later push passes, and does not change the result.
            { v, type: 'ci', at: t + 1, worktree: '/w/a', number: 1, sha: 'a1', ci: 'running' },
            { v, type: 'ci', at: t + 2, worktree: '/w/a', number: 1, sha: 'a1', ci: 'failed' },
            { v, type: 'ci', at: t + 3, worktree: '/w/a', number: 1, sha: 'a2', ci: 'passed' },
            { v, type: 'ci', at: t + 1, worktree: '/w/b', number: 2, sha: 'b1', ci: 'passed' },
            // A pull request with running checks only has no result yet.
            { v, type: 'ci', at: t + 1, worktree: '/w/c', number: 3, sha: 'c1', ci: 'running' }
        ];
        const stats = computeStats(events, { now: NOW, days: 7, groupBy: 'agent' });
        expect(stats.total).toMatchObject({ firstPushes: 2, firstPushFailures: 1, firstPushFailRate: 0.5 });
        expect(stats.rows.find(row => row.label === 'Claude Code')).toMatchObject({ firstPushes: 1, firstPushFailRate: 1 });
        expect(stats.rows.find(row => row.label === 'Codex')).toMatchObject({ firstPushes: 1, firstPushFailRate: 0 });
    });

    it('counts the wins in Compare agents by agent and by model', () => {
        const t = NOW - DAY;
        const runs = [
            { agentId: 'claude', agentName: 'Claude Code', worktree: '/w/a' },
            { agentId: 'codex', agentName: 'Codex', worktree: '/w/b' }
        ];
        const events: StatsEvent[] = [
            state(t, 's1', 'working', { model: 'claude-opus-4-1' }),
            { v, type: 'compare', at: t + HOUR, compare: 'c1', repoPath: '/code/api', task: 'Fix', winner: runs[1], runs },
            { v, type: 'compare', at: t + HOUR, compare: 'c2', repoPath: '/code/api', task: 'Fix', winner: runs[0], runs },
            { v, type: 'compare', at: t + 2 * HOUR, compare: 'c3', repoPath: '/code/api', task: 'Fix', winner: runs[1], runs }
        ];
        const stats = computeStats(events, { now: NOW, days: 7, groupBy: 'agent' });
        expect(stats.rows.find(row => row.label === 'Codex')).toMatchObject({ compareWins: 2, compareRuns: 3 });
        expect(stats.rows.find(row => row.label === 'Claude Code')).toMatchObject({ compareWins: 1, compareRuns: 3 });
        expect(stats.total).toMatchObject({ compareWins: 3, compareRuns: 6 });
        const byModel = computeStats(events, { now: NOW, days: 7, groupBy: 'model' });
        expect(byModel.rows.find(row => row.label === 'claude-opus-4-1')).toMatchObject({ compareWins: 1 });
        expect(byModel.rows.find(row => row.label === UNKNOWN_MODEL)).toMatchObject({ compareWins: 2 });
    });

    it('keeps only the events of the time range', () => {
        const events: StatsEvent[] = [
            { v, type: 'merge', at: NOW - 10 * DAY, number: 1 },
            { v, type: 'merge', at: NOW - 2 * DAY, number: 2 }
        ];
        expect(computeStats(events, { now: NOW, days: 7, groupBy: 'agent' }).total.merged).toBe(1);
        expect(computeStats(events, { now: NOW, days: 30, groupBy: 'agent' }).total.merged).toBe(2);
        expect(computeStats(events.slice(0, 1), { now: NOW, days: 7, groupBy: 'agent' }).empty).toBe(true);
    });

    it('sorts the rows by merged pull requests', () => {
        const t = NOW - DAY;
        const events: StatsEvent[] = [
            { v, type: 'start', at: t, worktree: '/w/a', agent: 'Aider' },
            { v, type: 'merge', at: t + 1, worktree: '/w/a', number: 1 },
            { v, type: 'start', at: t, worktree: '/w/b', agent: 'Codex' },
            { v, type: 'merge', at: t + 1, worktree: '/w/b', number: 2 },
            { v, type: 'start', at: t + 2, worktree: '/w/b', agent: 'Codex' },
            { v, type: 'merge', at: t + 3, worktree: '/w/b', number: 3 }
        ];
        expect(computeStats(events, { now: NOW, days: 7, groupBy: 'agent' }).rows.map(row => row.label)).toEqual(['Codex', 'Aider']);
    });
});

describe('page input', () => {
    it('reads a valid start and a valid CI change only', () => {
        expect(parseStatsStart({ worktree: '/w/a', agent: 'Codex', task: '', extra: 1 })).toEqual({ worktree: '/w/a', agent: 'Codex' });
        expect(parseStatsStart({ worktree: '' })).toBeUndefined();
        expect(parseStatsStart('x')).toBeUndefined();
        expect(parseStatsCi({ worktree: '/w/a', number: 7, sha: 'a1', ci: 'passed' })).toEqual({ worktree: '/w/a', number: 7, sha: 'a1', ci: 'passed' });
        expect(parseStatsCi({ worktree: '/w/a', number: 7.5, sha: 'a1', ci: 'passed' })).toBeUndefined();
        expect(parseStatsCi({ worktree: '/w/a', number: 7, sha: 'a1', ci: 'none' })).toBeUndefined();
    });

    it('gives the CI line of a pull request summary', () => {
        expect(statsCiChange('/w/a', { number: 7, headSha: 'a1', checks: 'FAILURE' })).toEqual({ worktree: '/w/a', number: 7, sha: 'a1', ci: 'failed' });
        expect(statsCiChange('/w/a', { number: 7, headSha: 'a1', checks: 'PENDING' })?.ci).toBe('running');
        expect(statsCiChange('/w/a', { number: 7, headSha: 'a1', checks: null })).toBeUndefined();
        expect(statsCiChange('/w/a', { number: 7, checks: 'SUCCESS' })).toBeUndefined();
        expect(statsCiChange('/w/a', undefined)).toBeUndefined();
    });

    it('formats a part as a percent', () => {
        expect(formatShare(undefined)).toBeUndefined();
        expect(formatShare(0)).toBe('0%');
        expect(formatShare(0.001)).toBe('<1%');
        expect(formatShare(0.256)).toBe('26%');
    });
});
