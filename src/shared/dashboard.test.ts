import { describe, expect, it } from 'vitest';
import {
    ageLevel,
    bucketMyPullRequests,
    groupReviewRequests,
    isHiddenComment,
    isStalePullRequest,
    matchesDashboardQuery,
    isMergedApproval,
    matchesRule,
    myPullRequestGroup,
    myPullRequestReasons,
    newComments,
    ownerQualifiers,
    parsePullRequestTitle,
    ruleRegex,
    shortAge,
    type MyPullRequestItem
} from './dashboard';

describe('myPullRequestReasons', () => {
    const base = { isDraft: false, reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checks: 'SUCCESS' };

    it('gives no reason while the pull request waits for other people', () => {
        expect(myPullRequestReasons({ ...base, reviewDecision: 'REVIEW_REQUIRED' })).toEqual([]);
        expect(myPullRequestReasons({ ...base, reviewDecision: 'APPROVED', checks: 'PENDING' })).toEqual([]);
    });

    it('finds the problems that the author must fix', () => {
        expect(myPullRequestReasons({ ...base, reviewDecision: 'CHANGES_REQUESTED', checks: 'FAILURE', mergeable: 'CONFLICTING' })).toEqual([
            'changes-requested',
            'ci-failing',
            'conflicts'
        ]);
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
        const result = newComments(
            [
                comment('old', 'ann', '2026-10-30T00:00:00Z'),
                comment('new', 'ann', '2026-11-02T00:00:00Z'),
                comment('bot', 'codecov', '2026-11-02T00:00:00Z', true),
                comment('ghost', null, '2026-11-02T00:00:00Z'),
                comment('mine', 'Me', '2026-11-01T12:00:00Z')
            ],
            'me',
            since
        );
        expect(result.map(item => item.id)).toEqual(['new']);
    });

    it('treats comments before the last reply of the viewer as seen', () => {
        const result = newComments(
            [comment('a', 'ann', '2026-11-02T00:00:00Z'), comment('reply', 'me', '2026-11-03T00:00:00Z'), comment('b', 'bob', '2026-11-04T00:00:00Z')],
            'me',
            since
        );
        expect(result.map(item => item.id)).toEqual(['b']);
    });
});

describe('isMergedApproval', () => {
    it('finds only an approval of a merged pull request', () => {
        expect(isMergedApproval({ reviewState: 'APPROVED', prState: 'MERGED' })).toBe(true);
        expect(isMergedApproval({ reviewState: 'APPROVED', prState: 'OPEN' })).toBe(false);
        expect(isMergedApproval({ reviewState: 'APPROVED', prState: 'CLOSED' })).toBe(false);
        expect(isMergedApproval({ reviewState: 'CHANGES_REQUESTED', prState: 'MERGED' })).toBe(false);
        expect(isMergedApproval({ prState: 'MERGED' })).toBe(false);
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
        expect(parsePullRequestTitle('fix: ABC-1201 — show the empty state on the home page')).toEqual({
            ticket: 'ABC-1201',
            text: 'show the empty state on the home page'
        });
        expect(parsePullRequestTitle('feat: abc-987 — add a dark mode toggle')).toEqual({ ticket: 'ABC-987', text: 'add a dark mode toggle' });
        expect(parsePullRequestTitle('ABC-1023: Sort the list by name')).toEqual({ ticket: 'ABC-1023', text: 'Sort the list by name' });
        expect(parsePullRequestTitle('feat: abc-1328 - upload UI')).toEqual({ ticket: 'ABC-1328', text: 'upload UI' });
        expect(parsePullRequestTitle('feat(api)!: ENG-1 add x')).toEqual({ ticket: 'ENG-1', text: 'add x' });
    });

    it('takes a ticket in brackets anywhere', () => {
        expect(parsePullRequestTitle('Faster pages: Phase 2 — Cache the user query (ABC-1040)')).toEqual({
            ticket: 'ABC-1040',
            text: 'Faster pages: Phase 2 — Cache the user query'
        });
        expect(parsePullRequestTitle('feat: add a settings page [CU-12abc3x]')).toEqual({ ticket: 'CU-12ABC3X', text: 'add a settings page' });
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

describe('Dashboard cards', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    const daysAgo = (days: number) => new Date(now - days * 24 * 3600 * 1000).toISOString();
    const pr = (number: number, days: number, reasons: MyPullRequestItem['reasons']): MyPullRequestItem => ({
        repo: { owner: 'acme', name: 'api' },
        number,
        title: `ENG-${number}: change ${number}`,
        url: `https://github.com/acme/api/pull/${number}`,
        updatedAt: daysAgo(days),
        reasons
    });

    it('puts a pull request without an update in 30 days in the stale card, whatever its reasons', () => {
        expect(isStalePullRequest(pr(1, 29, []), now)).toBe(false);
        expect(isStalePullRequest(pr(1, 30, []), now)).toBe(true);
        const buckets = bucketMyPullRequests([pr(1, 40, ['ready-to-merge']), pr(2, 2, ['ready-to-merge'])], now);
        expect(buckets.stale.map(item => item.number)).toEqual([1]);
        expect(buckets.ready.map(item => item.number)).toEqual([2]);
    });

    it('puts each active pull request in the card of its most urgent reason', () => {
        const buckets = bucketMyPullRequests(
            [pr(1, 1, ['changes-requested', 'ci-failing']), pr(2, 1, ['ci-failing']), pr(3, 3, ['conflicts']), pr(4, 1, ['ready-to-merge'])],
            now
        );
        expect(buckets.changes.map(item => item.number)).toEqual([1]);
        // The newest blocked pull request first.
        expect(buckets.blocked.map(item => item.number)).toEqual([2, 3]);
        expect(buckets.ready.map(item => item.number)).toEqual([4]);
    });

    it('gives the urgency of an age', () => {
        expect(ageLevel(daysAgo(2), now)).toBe('fresh');
        expect(ageLevel(daysAgo(8), now)).toBe('aging');
        expect(ageLevel(daysAgo(21), now)).toBe('old');
    });
});

describe('matchesDashboardQuery', () => {
    const item = { title: 'fix(api): ENG-12 limit query depth', repo: { owner: 'acme', name: 'web_app' }, number: 3410, author: 'nlewis' };

    it('matches every word of the query in the title, ticket, repository, number or author', () => {
        expect(matchesDashboardQuery(item, '')).toBe(true);
        expect(matchesDashboardQuery(item, 'eng-12')).toBe(true);
        expect(matchesDashboardQuery(item, 'WEB_APP depth')).toBe(true);
        expect(matchesDashboardQuery(item, '#3410')).toBe(true);
        expect(matchesDashboardQuery(item, 'nlewis')).toBe(true);
        expect(matchesDashboardQuery(item, 'depth mobile')).toBe(false);
    });
});

describe('groupReviewRequests', () => {
    const request = (author: string | null, repo: string, createdAt: string) => ({ author, repo: { owner: 'acme', name: repo }, createdAt });
    const items = [
        request('ann', 'api', '2026-05-03'),
        request('bob', 'web', '2026-05-01'),
        request('ann', 'web', '2026-05-02'),
        request(null, 'api', '2026-05-04')
    ];

    it('groups by author, the largest group first and the newest item first in a group', () => {
        const groups = groupReviewRequests(items, 'author');
        expect(groups.map(group => [group.key, group.items.map(entry => entry.createdAt)])).toEqual([
            ['ann', ['2026-05-03', '2026-05-02']],
            ['bob', ['2026-05-01']],
            ['unknown', ['2026-05-04']]
        ]);
    });

    it('groups by repository', () => {
        expect(groupReviewRequests(items, 'repo').map(group => group.key)).toEqual(['api', 'web']);
    });

    it('makes one list, the oldest first', () => {
        const groups = groupReviewRequests(items, 'oldest');
        expect(groups).toHaveLength(1);
        expect(groups[0].items.map(entry => entry.createdAt)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04']);
        expect(groupReviewRequests([], 'oldest')).toEqual([]);
    });
});
