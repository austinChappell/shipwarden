import { describe, expect, it } from 'vitest';
import { activeMention, applyMention, isLoginQuery, rankUsers, repoUrlOf, splitReferences } from './mentions';

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

    it('accepts letters with accents, so the query can be a part of a name', () => {
        expect(activeMention('cc @josé', 8)).toEqual({ trigger: '@', query: 'josé', start: 3 });
    });

    it('accepts single spaces after "@", for a full name', () => {
        expect(activeMention('cc @mona lis', 12)).toEqual({ trigger: '@', query: 'mona lis', start: 3 });
        expect(activeMention('@octocat ', 9)).toEqual({ trigger: '@', query: 'octocat ', start: 0 });
        expect(activeMention("@j. r. o'n", 10)).toEqual({ trigger: '@', query: "j. r. o'n", start: 0 });
    });

    it('stops at two spaces, a new line, a fifth word, or a space after "#"', () => {
        expect(activeMention('@octocat  ', 10)).toBeUndefined();
        expect(activeMention('@octocat\n', 9)).toBeUndefined();
        expect(activeMention('@a b c d e', 10)).toBeUndefined();
        expect(activeMention('#12 ', 4)).toBeUndefined();
    });

    it('starts at the last "@" when an earlier reference is in the same sentence', () => {
        expect(activeMention('@bob and @ann', 13)).toEqual({ trigger: '@', query: 'ann', start: 9 });
    });

    it('ignores a trigger in code', () => {
        expect(activeMention('Run `npm @sc', 12)).toBeUndefined();
        expect(activeMention('```\n@sc', 7)).toBeUndefined();
        expect(activeMention('```\ncode\n```\n@sc', 16)).toEqual({ trigger: '@', query: 'sc', start: 13 });
    });
});

describe('isLoginQuery', () => {
    it('accepts only the characters of a login', () => {
        expect(isLoginQuery('')).toBe(true);
        expect(isLoginQuery('mona-lisa_2')).toBe(true);
        expect(isLoginQuery('mona ')).toBe(false);
        expect(isLoginQuery('mona.')).toBe(false);
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

describe('rankUsers', () => {
    const logins = (users: { login: string }[]) => users.map(user => user.login);

    it('puts prefix matches first and removes duplicates', () => {
        const users = ['bob-ann', 'Ann', 'ann', 'carl', 'annie'].map(login => ({ login }));
        expect(logins(rankUsers(users, 'ann'))).toEqual(['Ann', 'annie', 'bob-ann']);
    });

    it('returns all users for an empty query, up to the limit', () => {
        expect(logins(rankUsers([{ login: 'a' }, { login: 'b' }, { login: 'c' }], '', 2))).toEqual(['a', 'b']);
    });

    it('matches the start of a word of the name, after the login matches', () => {
        const users = [{ login: 'mlisa', name: 'Mona Lisa' }, { login: 'zed', name: 'Lisa Ray' }, { login: 'lisa-dev' }, { login: 'xy', name: 'Annalisa' }];
        expect(logins(rankUsers(users, 'lisa'))).toEqual(['lisa-dev', 'mlisa', 'zed', 'xy']);
    });

    it('matches a query with spaces against the words of the name only', () => {
        const users = [{ login: 'mlisa', name: 'Mona Lisa' }, { login: 'octocat' }, { login: 'jro', name: "J.  R. O'Neil" }];
        expect(logins(rankUsers(users, 'mona lis'))).toEqual(['mlisa']);
        expect(logins(rankUsers(users, 'mona '))).toEqual(['mlisa']);
        expect(logins(rankUsers(users, 'mona x'))).toEqual([]);
        expect(logins(rankUsers(users, 'octocat '))).toEqual([]);
        expect(logins(rankUsers(users, "r. o'n"))).toEqual(['jro']);
    });

    it('ignores case and accents in the name', () => {
        expect(rankUsers([{ login: 'jp', name: 'José Peña' }], 'PENA')).toEqual([{ login: 'jp', name: 'José Peña' }]);
    });

    it('keeps the first position of a login and adds a name from a later duplicate', () => {
        const users = [{ login: 'Ann' }, { login: 'bo', name: 'Bo Diddley' }, { login: 'ann', name: 'Ann Smith' }];
        expect(rankUsers(users, '')).toEqual([
            { login: 'Ann', name: 'Ann Smith' },
            { login: 'bo', name: 'Bo Diddley' }
        ]);
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
