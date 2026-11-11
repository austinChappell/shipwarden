import { describe, expect, it } from 'vitest';
import { activeMention, applyMention, rankLogins, repoUrlOf, splitReferences } from './mentions';

describe('activeMention', () => {
    it('finds a user or an issue at the cursor', () => {
        expect(activeMention('Thanks @oc', 10)).toEqual({ trigger: '@', query: 'oc', start: 7 });
        expect(activeMention('#', 1)).toEqual({ trigger: '#', query: '', start: 0 });
        expect(activeMention('See (#12', 8)).toEqual({ trigger: '#', query: '12', start: 5 });
    });

    it('uses only the text before the cursor', () => {
        expect(activeMention('@octocat rest', 4)).toEqual({ trigger: '@', query: 'oct', start: 0 });
    });

    it('ignores a trigger in a word, such as an email address', () => {
        expect(activeMention('mail a@b', 8)).toBeUndefined();
        expect(activeMention('color#fff', 9)).toBeUndefined();
    });

    it('stops at a space after the query', () => {
        expect(activeMention('@octocat ', 9)).toBeUndefined();
    });

    it('ignores a trigger in code', () => {
        expect(activeMention('Run `npm @sc', 12)).toBeUndefined();
        expect(activeMention('```\n@sc', 7)).toBeUndefined();
        expect(activeMention('```\ncode\n```\n@sc', 16)).toEqual({ trigger: '@', query: 'sc', start: 13 });
    });
});

describe('applyMention', () => {
    it('replaces the query and adds a space', () => {
        const text = 'Thanks @oc';
        expect(applyMention(text, 10, { trigger: '@', query: 'oc', start: 7 }, '@octocat')).toEqual({ text: 'Thanks @octocat ', caret: 16 });
    });

    it('keeps the text after the cursor and does not add a second space', () => {
        const text = 'Fixes #1 in main';
        expect(applyMention(text, 8, { trigger: '#', query: '1', start: 6 }, '#123')).toEqual({ text: 'Fixes #123 in main', caret: 11 });
    });
});

describe('rankLogins', () => {
    it('puts prefix matches first and removes duplicates', () => {
        expect(rankLogins(['bob-ann', 'Ann', 'ann', 'carl', 'annie'], 'ann')).toEqual(['Ann', 'annie', 'bob-ann']);
    });

    it('returns all logins for an empty query, up to the limit', () => {
        expect(rankLogins(['a', 'b', 'c'], '', 2)).toEqual(['a', 'b']);
    });
});

describe('repoUrlOf', () => {
    it('removes the pull request part of the address', () => {
        expect(repoUrlOf('https://github.com/acme/app/pull/42')).toBe('https://github.com/acme/app');
        expect(repoUrlOf('https://dev.azure.com/acme/_git/app/pullrequest/42')).toBeUndefined();
    });
});

describe('splitReferences', () => {
    it('finds users and issues', () => {
        expect(splitReferences('cc @octocat, see #12.')).toEqual([
            { kind: 'text', text: 'cc ' },
            { kind: 'user', text: '@octocat', login: 'octocat' },
            { kind: 'text', text: ', see ' },
            { kind: 'issue', text: '#12', number: 12 },
            { kind: 'text', text: '.' }
        ]);
    });

    it('ignores email addresses, paths and color codes', () => {
        expect(splitReferences('a@b.com x/#1 #12a')).toEqual([{ kind: 'text', text: 'a@b.com x/#1 #12a' }]);
    });
});
