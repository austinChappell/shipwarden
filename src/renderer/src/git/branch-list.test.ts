import { describe, expect, it } from 'vitest';
import type { LocalBranch } from '@shared/branches';
import type { Plan } from '@shared/plans';
import { commitParts, groupRows, matchesText, passesFilter, prefixOf, stepsByBranch, ticketOf, withoutTicket, type BranchRow } from './branch-list';

const DAY = 24 * 3_600_000;

function row(name: string, date = 0, local: Partial<LocalBranch> = {}): BranchRow {
    return { name, label: name, date, subject: '', local: { name, commit: 'x', date, subject: '', upstream: `origin/${name}`, ...local } };
}

describe('commitParts', () => {
    it('reads a Conventional Commits subject', () => {
        expect(commitParts('fix(api): upgrade papaparse')).toEqual({ type: 'fix', text: 'upgrade papaparse' });
        expect(commitParts('feat!: drop node 18')).toEqual({ type: 'feat', text: 'drop node 18' });
    });

    it('reads the merge commits of GitHub and git', () => {
        expect(commitParts('Merge pull request #4011 from acme/story/ENG-1-x')).toEqual({ type: 'merge', text: 'PR #4011 · acme/story/ENG-1-x' });
        expect(commitParts("Merge branch 'main' into feat")).toEqual({ type: 'merge', text: 'main into feat' });
    });

    it('keeps other subjects as they are', () => {
        expect(commitParts('Update README.md')).toEqual({ text: 'Update README.md' });
    });
});

describe('ticketOf', () => {
    it('uses the task link first, then the branch name, then the subject', () => {
        const link = { pluginId: 'clickup', taskId: '1', key: 'CU-86ajr9ryg', title: 'T' };
        expect(ticketOf('story/eng-12205-x', 'ENG-1 fix', link)).toBe('CU-86ajr9ryg');
        expect(ticketOf('story/eng-12205-sign-hash', 'fix ENG-1')).toBe('ENG-12205');
        expect(ticketOf('cancel_job', 'fix: ENG-11553 cancel the job')).toBe('ENG-11553');
        expect(ticketOf('importer-v2', 'feat: add a row')).toBeUndefined();
    });

    it('reads a lowercase ticket at the start of the subject', () => {
        expect(ticketOf('exploration/importer', 'feat: eng-11328 — process the uploads')).toBe('ENG-11328');
    });
});

describe('withoutTicket', () => {
    it('removes the ticket and its separator from the start of the text', () => {
        expect(withoutTicket('ENG-12207 — call demo accounts', 'ENG-12207')).toBe('call demo accounts');
        expect(withoutTicket('eng-11328: process uploads', 'ENG-11328')).toBe('process uploads');
        expect(withoutTicket('[ENG-1] fix it', 'ENG-1')).toBe('fix it');
    });

    it('keeps a different ticket and a ticket in the middle', () => {
        expect(withoutTicket('ENG-2 — fix it', 'ENG-1')).toBe('ENG-2 — fix it');
        expect(withoutTicket('fix ENG-1 now', 'ENG-1')).toBe('fix ENG-1 now');
    });
});

describe('passesFilter', () => {
    const now = 10 * DAY;
    it('selects the branches of each chip', () => {
        const tree = row('a', now, { worktree: '/wt/a' }).local!;
        const main = row('b', now, { worktree: '/repo' }).local!;
        expect(passesFilter(tree, 'worktree', '/repo', now)).toBe(true);
        expect(passesFilter(main, 'worktree', '/repo', now)).toBe(false);
        expect(passesFilter(row('c', now, { behind: 2 }).local!, 'diverged', '/repo', now)).toBe(true);
        expect(passesFilter(row('d', now, { upstream: undefined }).local!, 'localOnly', '/repo', now)).toBe(true);
        expect(passesFilter(row('e', now, { gone: true }).local!, 'remoteDeleted', '/repo', now)).toBe(true);
        expect(passesFilter(row('f', now - 8 * DAY).local!, 'old', '/repo', now)).toBe(true);
        expect(passesFilter(row('g', now - DAY).local!, 'old', '/repo', now)).toBe(false);
    });
});

describe('matchesText', () => {
    it('matches the name, the ticket, and the subject', () => {
        const item = { ...row('feat/x'), ticket: 'ENG-7', subject: 'Fix the login' };
        expect(matchesText(item, 'eng-7')).toBe(true);
        expect(matchesText(item, 'login')).toBe(true);
        expect(matchesText(item, 'nope')).toBe(false);
    });
});

describe('groupRows', () => {
    it('groups by prefix, numbers the plan steps, and puts single branches into "other"', () => {
        const rows = [
            row('plan/demo-o9se/2-second', 5, { gone: true }),
            row('plan/demo-o9se/1-first', 1),
            row('story/a', 3),
            row('story/b', 2),
            row('claude/lonely', 9),
            row('pr3995', 4)
        ];
        const groups = groupRows(rows, 'prefix', new Map());
        expect(groups.map(group => [group.key, group.kind])).toEqual([
            ['plan/demo-o9se/', 'plan'],
            ['story/', 'prefix'],
            ['', 'other']
        ]);
        expect(groups[0].rows.map(item => [item.step, item.label])).toEqual([
            [1, 'first'],
            [2, 'second']
        ]);
        expect(groups[0].gone).toBe(1);
        expect(groups[0].newest).toBe(5);
        expect(groups[1].rows.map(item => item.label)).toEqual(['a', 'b']);
        expect(groups[2].rows.map(item => item.label)).toEqual(['claude/lonely', 'pr3995']);
    });

    it('counts the merged plan steps', () => {
        const plan = { steps: [{ branch: 'plan/p-1/1-a', mergedAt: 1 }, { branch: 'plan/p-1/2-b' }] } as unknown as Plan;
        const groups = groupRows([row('plan/p-1/1-a'), row('plan/p-1/2-b')], 'prefix', stepsByBranch([plan]));
        expect(groups[0].merged).toBe(1);
    });

    it('puts all rows into one group without grouping', () => {
        const groups = groupRows([row('story/a'), row('story/b')], 'none', new Map());
        expect(groups).toHaveLength(1);
        expect(groups[0].kind).toBe('all');
    });
});

describe('prefixOf', () => {
    it('returns the folders of a branch name', () => {
        expect(prefixOf('plan/x/1-a')).toBe('plan/x/');
        expect(prefixOf('main')).toBe('');
    });
});
