import { describe, expect, it } from 'vitest';
import {
    ACTIVE_OUTPUT_MS,
    ciStateOf,
    ciText,
    compareOverview,
    countStates,
    formatElapsed,
    IDLE_REASON_TEXT,
    idleReason,
    idleReasonText,
    lastActivityAt,
    overviewState
} from './agent-overview';

const NOW = 1_000_000_000;

describe('ciStateOf', () => {
    it('converts the combined check states', () => {
        expect(ciStateOf('FAILURE')).toBe('failed');
        expect(ciStateOf('ERROR')).toBe('failed');
        expect(ciStateOf('PENDING')).toBe('running');
        expect(ciStateOf('EXPECTED')).toBe('running');
        expect(ciStateOf('SUCCESS')).toBe('passed');
        expect(ciStateOf('success')).toBe('passed');
    });

    it('gives "none" for a pull request without checks and undefined without a pull request', () => {
        expect(ciStateOf(null)).toBe('none');
        expect(ciStateOf(undefined)).toBeUndefined();
        expect(ciStateOf('STRANGE')).toBeUndefined();
    });
});

describe('overviewState', () => {
    it('keeps the hook states for an agent that works or needs the user', () => {
        expect(overviewState({ agentState: 'waiting', ci: 'failed', now: NOW })).toBe('waiting');
        expect(overviewState({ agentState: 'working', ci: 'failed', now: NOW })).toBe('working');
        expect(overviewState({ agentState: 'starting', now: NOW })).toBe('starting');
    });

    it('shows a finished agent as blocked while its checks run or after they fail', () => {
        expect(overviewState({ agentState: 'done', ci: 'failed', now: NOW })).toBe('blocked-ci');
        expect(overviewState({ agentState: 'done', ci: 'running', now: NOW })).toBe('blocked-ci');
        expect(overviewState({ agentState: 'idle', ci: 'running', now: NOW })).toBe('blocked-ci');
    });

    it('shows a finished agent as done when CI does not block it', () => {
        expect(overviewState({ agentState: 'done', ci: 'passed', now: NOW })).toBe('done');
        expect(overviewState({ agentState: 'done', ci: 'none', now: NOW })).toBe('done');
        expect(overviewState({ agentState: 'done', now: NOW })).toBe('done');
    });

    it('shows a ready agent without a prompt as waiting for input', () => {
        expect(overviewState({ agentState: 'idle', now: NOW })).toBe('waiting');
        expect(overviewState({ agentState: 'idle', ci: 'passed', now: NOW })).toBe('waiting');
    });

    it('uses the terminal output for an agent without hooks', () => {
        expect(overviewState({ lastOutputAt: NOW - 1000, now: NOW })).toBe('working');
        expect(overviewState({ lastOutputAt: NOW - ACTIVE_OUTPUT_MS, now: NOW })).toBe('quiet');
        expect(overviewState({ now: NOW })).toBe('quiet');
    });

    it('uses CI for an agent without hooks when its terminal is quiet', () => {
        expect(overviewState({ lastOutputAt: NOW - 60_000, ci: 'failed', now: NOW })).toBe('blocked-ci');
        expect(overviewState({ lastOutputAt: NOW - 1000, ci: 'failed', now: NOW })).toBe('working');
    });
});

describe('ciText', () => {
    it('describes each CI state', () => {
        expect(ciText('failed')).toBe('CI failed');
        expect(ciText('running')).toBe('CI running');
        expect(ciText('passed')).toBe('CI passed');
        expect(ciText('none')).toBe('No checks');
        expect(ciText(undefined)).toBeUndefined();
    });
});

describe('lastActivityAt', () => {
    it('takes the newer time', () => {
        expect(lastActivityAt(5, 9)).toBe(9);
        expect(lastActivityAt(9, 5)).toBe(9);
        expect(lastActivityAt(undefined, 5)).toBe(5);
        expect(lastActivityAt(5, undefined)).toBe(5);
        expect(lastActivityAt(undefined, undefined)).toBeUndefined();
    });
});

describe('formatElapsed', () => {
    it('formats seconds, minutes, hours and days', () => {
        expect(formatElapsed(NOW, NOW)).toBe('0s');
        expect(formatElapsed(NOW - 8_000, NOW)).toBe('8s');
        expect(formatElapsed(NOW - 185_000, NOW)).toBe('3m 05s');
        expect(formatElapsed(NOW - (2 * 3600 + 5 * 60) * 1000, NOW)).toBe('2h 5m');
        expect(formatElapsed(NOW - 27 * 3600 * 1000, NOW)).toBe('1d 3h');
    });

    it('gives 0s for a time in the future and undefined for no time', () => {
        expect(formatElapsed(NOW + 5000, NOW)).toBe('0s');
        expect(formatElapsed(undefined, NOW)).toBeUndefined();
    });
});

describe('compareOverview', () => {
    it('puts the state that needs the user first, then the oldest activity', () => {
        const list = [
            { id: 'done', state: 'done' as const, activityAt: 1 },
            { id: 'working', state: 'working' as const, activityAt: 1 },
            { id: 'waiting-new', state: 'waiting' as const, activityAt: 20 },
            { id: 'ci', state: 'blocked-ci' as const, activityAt: 1 },
            { id: 'waiting-old', state: 'waiting' as const, activityAt: 10 }
        ];
        expect([...list].sort(compareOverview).map(item => item.id)).toEqual(['waiting-old', 'waiting-new', 'ci', 'working', 'done']);
    });
});

describe('countStates', () => {
    it('counts only the states that have agents, in list order', () => {
        expect(countStates(['done', 'working', 'waiting', 'working'])).toEqual([
            { state: 'waiting', count: 1 },
            { state: 'working', count: 2 },
            { state: 'done', count: 1 }
        ]);
        expect(countStates([])).toEqual([]);
    });
});

describe('idleReason', () => {
    const now = 1_000_000;

    it('gives no reason while the agent works or starts', () => {
        expect(idleReason({ agentState: 'working', now })).toBeUndefined();
        expect(idleReason({ agentState: 'starting', now })).toBeUndefined();
        expect(idleReason({ lastOutputAt: now - 1000, now })).toBeUndefined();
    });

    it('maps each hook notification to its reason', () => {
        expect(idleReason({ agentState: 'waiting', waitFor: 'permission', now })).toBe('permission');
        expect(idleReason({ agentState: 'waiting', waitFor: 'question', now })).toBe('question');
        expect(idleReason({ agentState: 'waiting', waitFor: 'input', now })).toBe('input');
        // A PTY host of an older build sends no "waitFor".
        expect(idleReason({ agentState: 'waiting', now })).toBe('input');
    });

    it('waits for the first prompt or for the reply after a turn', () => {
        expect(idleReason({ agentState: 'idle', now })).toBe('prompt');
        expect(idleReason({ agentState: 'done', now })).toBe('reply');
        expect(idleReason({ agentState: 'done', ci: 'passed', now })).toBe('reply');
        expect(idleReason({ agentState: 'done', ci: 'none', now })).toBe('reply');
    });

    it('gives the CI state after the turn', () => {
        expect(idleReason({ agentState: 'done', ci: 'running', now })).toBe('ci-running');
        expect(idleReason({ agentState: 'done', ci: 'failed', now })).toBe('ci-failed');
        expect(idleReason({ agentState: 'idle', ci: 'running', now })).toBe('ci-running');
        expect(idleReason({ agentState: 'exited', ci: 'failed', exited: true, now })).toBe('ci-failed');
        expect(idleReason({ ci: 'running', now })).toBe('ci-running');
        // A question of the agent wins over CI.
        expect(idleReason({ agentState: 'waiting', waitFor: 'question', ci: 'failed', now })).toBe('question');
    });

    it('maps each process state to its reason', () => {
        expect(idleReason({ agentState: 'exited', now })).toBe('session-ended');
        expect(idleReason({ agentState: 'exited', exited: true, exitCode: 0, now })).toBe('process-stopped');
        expect(idleReason({ agentState: 'exited', exited: true, exitCode: 1, now })).toBe('process-failed');
        expect(idleReason({ exited: true, now })).toBe('process-stopped');
        expect(idleReason({ exited: true, exitCode: 137, now })).toBe('process-failed');
    });

    it('tells that an agent without hooks does not report', () => {
        expect(idleReason({ now })).toBe('no-report');
        expect(idleReason({ lastOutputAt: now - ACTIVE_OUTPUT_MS, now })).toBe('no-report');
    });

    it('gives the text of the reason', () => {
        expect(idleReasonText({ agentState: 'waiting', waitFor: 'permission', now })).toBe('Waiting for a permission prompt');
        expect(idleReasonText({ agentState: 'done', ci: 'running', now })).toBe('Waiting for CI');
        expect(idleReasonText({ agentState: 'working', now })).toBeUndefined();
        for (const text of Object.values(IDLE_REASON_TEXT)) expect(text).not.toMatch(/[.;]$/);
    });
});
