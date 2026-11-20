import { describe, expect, it } from 'vitest';
import type { RebaseConflictInput } from './git';
import { templateVariables } from './automation-templates';
import {
    CONFLICT_VARIABLES,
    conflictValues,
    DEFAULT_CONFLICT_TEMPLATE,
    overlapLines,
    rebaseConflictPrompt,
    resolveRule,
    restackConflictPrompt
} from './rebase-conflict';

const input: RebaseConflictInput = {
    branch: 'feature',
    onto: 'origin/main',
    files: ['src/a.ts', 'src/b.ts'],
    stopped: { hash: 'abc1234', subject: 'Change the login' },
    branchCommits: ['abc1234 Change the login'],
    baseCommits: ['def5678 Rename the user field', '0123456 Add the token']
};

const overlap = {
    peers: [
        { path: '/w/other', branch: 'other', files: ['src/a.ts', 'src/c.ts'] },
        { path: '/w/third', branch: 'third', files: ['src/c.ts'] }
    ]
};

describe('rebaseConflictPrompt', () => {
    it('gives the agent the files, the commits of both sides, and the overlap', () => {
        const prompt = rebaseConflictPrompt(input, overlap);
        expect(prompt).toContain('The rebase of feature onto origin/main stopped on a merge conflict at commit abc1234 "Change the login".');
        expect(prompt).toContain('- src/a.ts\n- src/b.ts');
        expect(prompt).toContain('The commits of feature that change these files:\n- abc1234 Change the login');
        expect(prompt).toContain('The commits of origin/main that change these files:\n- def5678 Rename the user field\n- 0123456 Add the token');
        expect(prompt).toContain('- other (/w/other): src/a.ts');
        expect(prompt).not.toContain('third');
        expect(prompt).toContain(resolveRule('feature'));
        expect(prompt).toContain('Do not run "git rebase --continue"');
        expect(prompt).not.toContain('{{');
    });

    it('writes "None." for empty lists', () => {
        const values = conflictValues({ ...input, branchCommits: [], baseCommits: [] });
        expect(values['conflict.branchCommits']).toBe('None.');
        expect(values['conflict.overlap']).toBe('None.');
    });

    it('uses the text of the user template when there is one', () => {
        expect(rebaseConflictPrompt(input, undefined, 'Fix {{conflict.files}} in {{conflict.branch}}.')).toBe('Fix - src/a.ts\n- src/b.ts in feature.');
        expect(rebaseConflictPrompt(input, undefined, '  ')).toContain('The files with conflicts:');
    });

    it('fills each variable of the default text, and documents each one', () => {
        const names = CONFLICT_VARIABLES.map(variable => variable.name);
        expect(templateVariables(DEFAULT_CONFLICT_TEMPLATE).every(name => names.includes(name))).toBe(true);
        expect(Object.keys(conflictValues(input)).sort()).toEqual([...names].sort());
    });
});

describe('overlapLines', () => {
    it('lists only the worktrees that change a file with a conflict', () => {
        expect(overlapLines(overlap, ['src/c.ts'])).toEqual(['other (/w/other): src/c.ts', 'third (/w/third): src/c.ts']);
        expect(overlapLines(undefined, ['src/a.ts'])).toEqual([]);
    });
});

describe('restackConflictPrompt', () => {
    it('tells the agent why the rebase ran, and to continue the rebase, test, and push with a lease', () => {
        const prompt = restackConflictPrompt(input, { number: 42, url: 'https://github.com/o/r/pull/42' }, 41, overlap);
        expect(prompt).toContain('Pull request #41 merged. ShipWarden rebased feature onto origin/main, so that pull request #42');
        expect(prompt).toContain('- src/a.ts\n- src/b.ts');
        expect(prompt).toContain('- other (/w/other): src/a.ts');
        expect(prompt).toContain('"git rebase --continue"');
        expect(prompt).toContain('Run "git push --force-with-lease origin feature".');
        expect(prompt).toContain('do not use "--force"');
    });
});
