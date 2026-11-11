import { describe, expect, it, vi } from 'vitest';
import type { ProcessRow } from '@shared/processes';
import { STALE_SHELL_MS, type TerminalSession } from '@shared/terminal';
import { shellAtPrompt, StaleShellCloser, staleShellIds } from './stale-shells';

const NOW = 1_000_000_000_000;
const OLD = NOW - STALE_SHELL_MS - 1;

const session = (fields: Partial<TerminalSession>): TerminalSession => ({
    id: 's',
    title: 'shell',
    cwd: '/w',
    worktreePath: '/w',
    isAgent: false,
    pid: 100,
    exited: false,
    lastActiveAt: OLD,
    ...fields
});

/** A shell row. `tpgid` is the foreground group of its terminal: the shell group at the prompt, else the group of a command. */
const row = (pid: number, tpgid: number): ProcessRow => ({ pid, ppid: 1, pgid: pid, tpgid, cpu: 0, rssKb: 0, elapsed: '00:01', command: '-zsh' });

describe('shellAtPrompt', () => {
    it('is true when the shell group is in the foreground', () => {
        expect(shellAtPrompt([row(100, 100)], 100)).toBe(true);
    });

    it('is false when a command runs in the foreground, or the shell is missing', () => {
        expect(shellAtPrompt([row(100, 200)], 100)).toBe(false);
        expect(shellAtPrompt([], 100)).toBe(false);
    });
});

describe('staleShellIds', () => {
    const rows = [row(100, 100), row(101, 101), row(102, 999)];

    it('returns the idle shells at their prompt', () => {
        expect(staleShellIds([session({ id: 'a' })], rows, NOW)).toEqual(['a']);
    });

    it('keeps a shell with recent activity', () => {
        expect(staleShellIds([session({ lastActiveAt: NOW - STALE_SHELL_MS + 1000 })], rows, NOW)).toEqual([]);
    });

    it('keeps a shell that runs a command', () => {
        expect(staleShellIds([session({ pid: 102 })], rows, NOW)).toEqual([]);
    });

    it('keeps agent tabs, shells with an agent, and sessions of an older host', () => {
        expect(
            staleShellIds(
                [
                    session({ id: 'agent', isAgent: true }),
                    session({ id: 'program', pid: 101, agentProgram: 'claude' }),
                    session({ id: 'old-host', lastActiveAt: undefined }),
                    session({ id: 'no-worktree', worktreePath: undefined }),
                    session({ id: 'exited', exited: true })
                ],
                rows,
                NOW
            )
        ).toEqual([]);
    });
});

describe('StaleShellCloser', () => {
    const deps = (enabled: boolean, sessions: TerminalSession[]) => ({
        enabled: async () => enabled,
        sessions: async () => sessions,
        processTable: vi.fn(async () => [row(100, 100)]),
        close: vi.fn(async () => undefined)
    });

    it('closes the stale shells when the setting is on', async () => {
        const d = deps(true, [session({ id: 'a' })]);
        expect(await new StaleShellCloser(d).check(NOW)).toEqual(['a']);
        expect(d.close).toHaveBeenCalledWith('a');
    });

    it('does nothing when the setting is off', async () => {
        const d = deps(false, [session({ id: 'a' })]);
        expect(await new StaleShellCloser(d).check(NOW)).toEqual([]);
        expect(d.close).not.toHaveBeenCalled();
    });

    it('does not read the process table when no shell is stale', async () => {
        const d = deps(true, [session({ lastActiveAt: NOW })]);
        await new StaleShellCloser(d).check(NOW);
        expect(d.processTable).not.toHaveBeenCalled();
    });
});
