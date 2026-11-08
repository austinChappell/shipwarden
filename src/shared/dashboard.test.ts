import { describe, expect, it } from 'vitest';
import { isHiddenComment, matchesRule, myPullRequestGroup, myPullRequestReasons, newComments, ownerQualifiers, parsePullRequestTitle, ruleRegex, shortAge } from './dashboard';

describe('myPullRequestReasons', () => {
    const base = { isDraft: false, reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checks: 'SUCCESS' };

    it('gives no reason while the pull request waits for other people', () => {
        expect(myPullRequestReasons({ ...base, reviewDecision: 'REVIEW_REQUIRED' })).toEqual([]);
        expect(myPullRequestReasons({ ...base, reviewDecision: 'APPROVED', checks: 'PENDING' })).toEqual([]);
    });

    it('finds the problems that the author must fix', () => {
        expect(myPullRequestReasons({ ...base, reviewDecision: 'CHANGES_REQUESTED', checks: 'FAILURE', mergeable: 'CONFLICTING' }))
            .toEqual(['changes-requested', 'ci-failing', 'conflicts']);
    });

    it('shows an approved pull request with passing checks as ready to merge, but not a draft', () => {
        expect(myPullRequestReasons({ ...base, reviewDecision: 'APPROVED' })).toEqual(['ready-to-merge']);
        expect(myPullRequestReasons({ ...base, reviewDecision: 'APPROVED', checks: null })).toEqual(['ready-to-merge']);
        expect(myPullRequestReasons({ ...base, reviewDecision: 'APPROVED', isDraft: true })).toEqual([]);
    });
});

describe('newComments', () => {
    const since = new Date('2026-11-01T00:00:00Z');
    const comment = (id: string, author: string | null, createdAt: string, isBot = false) => ({ id, author, createdAt, isBot });

    it('keeps comments from other people after the window start', () => {
        const result = newComments([
            comment('old', 'ann', '2026-10-30T00:00:00Z'),
            comment('new', 'ann', '2026-11-02T00:00:00Z'),
            comment('bot', 'codecov', '2026-11-02T00:00:00Z', true),
            comment('ghost', null, '2026-11-02T00:00:00Z'),
            comment('mine', 'Me', '2026-11-01T12:00:00Z')
        ], 'me', since);
        expect(result.map(item => item.id)).toEqual(['new']);
    });

    it('treats comments before the last reply of the viewer as seen', () => {
        const result = newComments([
            comment('a', 'ann', '2026-11-02T00:00:00Z'),
            comment('reply', 'me', '2026-11-03T00:00:00Z'),
            comment('b', 'bob', '2026-11-04T00:00:00Z')
        ], 'me', since);
        expect(result.map(item => item.id)).toEqual(['b']);
    });
});

describe('ownerQualifiers', () => {
    it('limits the search to the chosen owners', () => {
        expect(ownerQualifiers(['acme', 'me'])).toBe('user:acme user:me');
        expect(ownerQualifiers('all')).toBe('');
        expect(ownerQualifiers(undefined)).toBe('');
    });
});

describe('hidden comment rules', () => {
    const linked = 'Linked to ClickUp task: ABC-1234';

    it('matches the start, a part, or a regular expression, without case', () => {
        expect(matchesRule({ id: '1', match: 'startsWith', text: 'linked to clickup task:' }, 'anyone', `  ${linked}`)).toBe(true);
        expect(matchesRule({ id: '1', match: 'startsWith', text: 'ClickUp' }, 'anyone', linked)).toBe(false);
        expect(matchesRule({ id: '1', match: 'contains', text: 'clickup task' }, 'anyone', linked)).toBe(true);
        expect(matchesRule({ id: '1', match: 'regex', text: '^Linked to ClickUp task: ABC-\\d+$' }, 'anyone', linked)).toBe(true);
    });

    it('applies only to its author when the rule has one', () => {
        const rule = { id: '1', author: 'AcmeBot', match: 'startsWith' as const, text: 'Linked to' };
        expect(matchesRule(rule, 'acmebot', linked)).toBe(true);
        expect(matchesRule(rule, 'ann', linked)).toBe(false);
    });

    it('does not match with a regular expression that is not valid', () => {
        expect(typeof ruleRegex('(')).toBe('string');
        expect(matchesRule({ id: '1', match: 'regex', text: '(' }, 'ann', '(')).toBe(false);
    });

    it('hides a comment by its author or by a rule', () => {
        const filter = { hiddenAuthors: ['bot-user'], hiddenRules: [{ id: '1', match: 'contains' as const, text: 'deploy preview' }] };
        expect(isHiddenComment('Bot-User', 'hello', filter)).toBe(true);
        expect(isHiddenComment('ann', 'Your deploy preview is ready', filter)).toBe(true);
        expect(isHiddenComment('ann', 'Please rename this', filter)).toBe(false);
    });
});

describe('parsePullRequestTitle', () => {
    it('takes the ticket from the start and removes the commit type', () => {
        expect(parsePullRequestTitle('fix: ABC-1201 — show the empty state on the home page')).toEqual({ ticket: 'ABC-1201', text: 'show the empty state on the home page' });
        expect(parsePullRequestTitle('feat: abc-987 — add a dark mode toggle')).toEqual({ ticket: 'ABC-987', text: 'add a dark mode toggle' });
        expect(parsePullRequestTitle('ABC-1023: Sort the list by name')).toEqual({ ticket: 'ABC-1023', text: 'Sort the list by name' });
        expect(parsePullRequestTitle('feat: abc-1328 - upload UI')).toEqual({ ticket: 'ABC-1328', text: 'upload UI' });
        expect(parsePullRequestTitle('feat(api)!: ENG-1 add x')).toEqual({ ticket: 'ENG-1', text: 'add x' });
    });

    it('takes a ticket in brackets anywhere', () => {
        expect(parsePullRequestTitle('Faster pages: Phase 2 — Cache the user query (ABC-1040)'))
            .toEqual({ ticket: 'ABC-1040', text: 'Faster pages: Phase 2 — Cache the user query' });
        expect(parsePullRequestTitle('feat: add a settings page [CU-12abc3x]'))
            .toEqual({ ticket: 'CU-12ABC3X', text: 'add a settings page' });
    });

    it('keeps a title without a ticket, and a ticket in the middle', () => {
        expect(parsePullRequestTitle('feat: add a help page')).toEqual({ text: 'add a help page' });
        expect(parsePullRequestTitle('Use "there" as the default name')).toEqual({ text: 'Use "there" as the default name' });
        expect(parsePullRequestTitle('Port the ABC-5 fix to mobile')).toEqual({ text: 'Port the ABC-5 fix to mobile' });
    });
});

describe('myPullRequestGroup and shortAge', () => {
    it('puts a pull request in the group of its most urgent reason', () => {
        expect(myPullRequestGroup(['ci-failing', 'conflicts'])).toBe('conflicts');
        expect(myPullRequestGroup(['ready-to-merge'])).toBe('ready-to-merge');
        expect(myPullRequestGroup(['ci-failing', 'changes-requested'])).toBe('changes-requested');
    });

    it('gives a short age', () => {
        const now = Date.parse('2026-11-07T12:00:00Z');
        expect(shortAge('2026-11-07T11:58:00Z', now)).toBe('2m');
        expect(shortAge('2026-11-07T02:00:00Z', now)).toBe('10h');
        expect(shortAge('2026-11-02T12:00:00Z', now)).toBe('5d');
        expect(shortAge('2026-10-01T12:00:00Z', now)).toBe('5w');
    });
});
