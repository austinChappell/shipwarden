import { describe, expect, it } from 'vitest';
import {
    hasNewActivity,
    isSnooze,
    isSnoozeActive,
    isSnoozeOld,
    makeSnooze,
    nextSnoozeEnd,
    openPullRequestActivity,
    pipelineRunActivity,
    isPipelineSnoozeKey,
    pipelineSnoozeKey,
    snoozedPipelineOf,
    runSnoozeKey,
    snoozeChoices,
    snoozeKey,
    SNOOZE_KEEP_MS,
    snoozeEnd,
    snoozeText,
    type PullRequestActivity
} from './snooze';
import type { PipelineApprovalItem } from './dashboard';
import type { OpenPullRequest } from './review-queue';

const base: PullRequestActivity = { head: 'a1', lastActivityAt: '2026-11-20T10:00:00Z', updatedAt: '2026-11-20T10:00:00Z', needs: 'review' };

describe('hasNewActivity', () => {
    it('is false for the same state', () => {
        expect(hasNewActivity(base, { ...base })).toBe(false);
    });

    it('is true after a new commit, a rebase, or a force push', () => {
        expect(hasNewActivity(base, { ...base, head: 'b2' })).toBe(true);
    });

    it('is true after a new comment or review from another person', () => {
        expect(hasNewActivity(base, { ...base, lastActivityAt: '2026-11-21T08:00:00Z' })).toBe(true);
        expect(hasNewActivity({ ...base, lastActivityAt: undefined }, base)).toBe(true);
    });

    it('is false for older data from another view', () => {
        expect(hasNewActivity(base, { ...base, lastActivityAt: '2026-11-19T08:00:00Z' })).toBe(false);
        expect(hasNewActivity(base, { ...base, lastActivityAt: undefined })).toBe(false);
    });

    it('is true when the needs of the pull request change', () => {
        expect(hasNewActivity({ ...base, needs: 'conflicts' }, { ...base, needs: 'ready-to-merge' })).toBe(true);
        expect(hasNewActivity({ ...base, needs: '' }, { ...base, needs: 'review' })).toBe(true);
        expect(hasNewActivity({ ...base, needs: undefined }, { ...base, needs: 'review' })).toBe(false);
    });

    it('uses the update time only when no view knows the head commit', () => {
        const later = { updatedAt: '2026-11-22T00:00:00Z' };
        expect(hasNewActivity({ updatedAt: base.updatedAt }, later)).toBe(true);
        expect(hasNewActivity({ updatedAt: base.updatedAt }, { updatedAt: base.updatedAt })).toBe(false);
        expect(hasNewActivity({ ...base, lastActivityAt: undefined }, { ...base, lastActivityAt: undefined, ...later })).toBe(false);
    });
});

describe('isSnoozeActive', () => {
    const now = Date.parse('2026-11-23T12:00:00Z');

    it('hides the pull request until the end time', () => {
        expect(isSnoozeActive({ at: now - 1000, until: now + 1000 }, base, now)).toBe(true);
        expect(isSnoozeActive({ at: now - 1000, until: now }, base, now)).toBe(false);
    });

    it('does not end a timed snooze for new activity', () => {
        expect(isSnoozeActive({ at: now - 1000, until: now + 1000 }, { ...base, head: 'b2' }, now)).toBe(true);
    });

    it('hides the pull request until new activity', () => {
        const snooze = { at: now - 1000, activity: base };
        expect(isSnoozeActive(snooze, base, now)).toBe(true);
        expect(isSnoozeActive(snooze, { ...base, head: 'b2' }, now)).toBe(false);
    });

    it('is false without a snooze', () => {
        expect(isSnoozeActive(undefined, base, now)).toBe(false);
    });
});

describe('snoozeEnd', () => {
    // Monday, 23 November 2026, 14:30 local time.
    const monday = new Date(2026, 10, 23, 14, 30);

    it('adds the hours', () => {
        expect(snoozeEnd('hour', monday)).toBe(monday.getTime() + 3600_000);
        expect(snoozeEnd('hours', monday)).toBe(monday.getTime() + 4 * 3600_000);
    });

    it('ends tomorrow at 9:00', () => {
        expect(snoozeEnd('tomorrow', monday)).toBe(new Date(2026, 10, 24, 9).getTime());
    });

    it('ends on the next Monday at 9:00', () => {
        expect(snoozeEnd('week', monday)).toBe(new Date(2026, 10, 30, 9).getTime());
        expect(snoozeEnd('week', new Date(2026, 10, 28, 22))).toBe(new Date(2026, 10, 30, 9).getTime());
        expect(snoozeEnd('week', new Date(2026, 10, 29, 8))).toBe(new Date(2026, 10, 30, 9).getTime());
    });

    it('has no end for "until new activity"', () => {
        expect(snoozeEnd('activity', monday)).toBeUndefined();
    });
});

describe('makeSnooze', () => {
    const now = new Date(2026, 10, 23, 14, 30);

    it('keeps the activity state only for a snooze until new activity', () => {
        expect(makeSnooze('activity', base, now)).toEqual({ at: now.getTime(), activity: base });
        expect(makeSnooze('hour', base, now)).toEqual({ at: now.getTime(), until: now.getTime() + 3600_000 });
    });
});

describe('isSnooze', () => {
    it('accepts the two kinds of snooze', () => {
        expect(isSnooze({ at: 1, until: 2 })).toBe(true);
        expect(isSnooze({ at: 1, activity: { head: 'a' } })).toBe(true);
    });

    it('refuses bad data', () => {
        expect(isSnooze(null)).toBe(false);
        expect(isSnooze({ at: 1 })).toBe(false);
        expect(isSnooze({ at: 1, until: 2, activity: {} })).toBe(false);
        expect(isSnooze({ at: '1', until: 2 })).toBe(false);
        expect(isSnooze({ at: 1, activity: { head: 3 } })).toBe(false);
    });
});

describe('isSnoozeOld', () => {
    it('is true after the end time, or after the keep time for a snooze until new activity', () => {
        expect(isSnoozeOld({ at: 0, until: 10 }, 10)).toBe(true);
        expect(isSnoozeOld({ at: 0, until: 10 }, 9)).toBe(false);
        expect(isSnoozeOld({ at: 0, activity: {} }, SNOOZE_KEEP_MS)).toBe(false);
        expect(isSnoozeOld({ at: 0, activity: {} }, SNOOZE_KEEP_MS + 1)).toBe(true);
    });
});

describe('snoozeText', () => {
    const now = new Date(2026, 10, 23, 14, 30);

    it('names the end of the snooze', () => {
        expect(snoozeText({ at: 0, activity: {} }, now)).toBe('until new activity');
        expect(snoozeText({ at: 0, until: new Date(2026, 10, 23, 18, 30).getTime() }, now, 'en-US')).toBe('until 6:30 PM');
        expect(snoozeText({ at: 0, until: new Date(2026, 10, 24, 9).getTime() }, now, 'en-US')).toBe('until tomorrow at 9:00 AM');
        expect(snoozeText({ at: 0, until: new Date(2026, 10, 27, 9).getTime() }, now, 'en-US')).toBe('until Friday at 9:00 AM');
        expect(snoozeText({ at: 0, until: new Date(2026, 11, 7, 9).getTime() }, now, 'en-US')).toBe('until Dec 7 at 9:00 AM');
    });
});

describe('nextSnoozeEnd', () => {
    it('returns the first end after now', () => {
        expect(nextSnoozeEnd({ a: { at: 0, until: 50 }, b: { at: 0, until: 30 }, c: { at: 0, until: 5 }, d: { at: 0, activity: {} } }, 10)).toBe(30);
        expect(nextSnoozeEnd({ d: { at: 0, activity: {} } }, 10)).toBeUndefined();
    });
});

describe('openPullRequestActivity', () => {
    const pr = {
        headRefOid: 'a1',
        lastActivityAt: '2026-11-20T10:00:00Z',
        updatedAt: '2026-11-20T11:00:00Z',
        viewerDidAuthor: false,
        reviewRequested: true,
        actions: []
    } as unknown as OpenPullRequest;

    it('says "review" for a request, and gives the reasons of a pull request of the user in a fixed order', () => {
        expect(openPullRequestActivity(pr).needs).toBe('review');
        expect(openPullRequestActivity({ ...pr, reviewRequested: false }).needs).toBe('');
        expect(openPullRequestActivity({ ...pr, viewerDidAuthor: true, actions: ['conflicts', 'ci-failing'] }).needs).toBe('ci-failing,conflicts');
    });
});

describe('pipeline run snoozes', () => {
    const run: PipelineApprovalItem = {
        id: 'github:o/app:7',
        source: 'app',
        sourceTitle: 'o/app',
        workflow: 'Deploy',
        title: 'Release',
        environments: ['staging'],
        url: 'https://github.com/o/app/actions/runs/7',
        createdAt: '2026-11-20T10:00:00Z',
        target: { kind: 'github', repo: { owner: 'o', name: 'app' }, runId: 7, environmentIds: [20, 3] }
    };

    it('uses a key that does not match the key of a pull request', () => {
        expect(runSnoozeKey(run.id)).toBe('run:github:o/app:7');
        expect(runSnoozeKey(run.id)).not.toBe(snoozeKey(run.url));
    });

    it('ends a snooze "until the run changes" when the run waits at a different stage', () => {
        const snooze = makeSnooze('activity', pipelineRunActivity(run), new Date(0));
        expect(isSnooze(snooze)).toBe(true);
        expect(isSnoozeActive(snooze, pipelineRunActivity({ ...run, target: { ...run.target, environmentIds: [3, 20] } as typeof run.target }), 1)).toBe(true);
        expect(isSnoozeActive(snooze, pipelineRunActivity({ ...run, target: { ...run.target, environmentIds: [21] } as typeof run.target }), 1)).toBe(false);
        const azure = pipelineRunActivity({ ...run, target: { kind: 'azure', organization: 'org', project: 'p', approvalIds: ['b', 'a'] } });
        expect(azure.needs).toBe('a,b');
    });

    it('uses a pipeline key that does not match the key of a run', () => {
        expect(pipelineSnoozeKey('github:o/app:workflow:5')).toBe('pipeline:github:o/app:workflow:5');
        expect(pipelineSnoozeKey(run.id)).not.toBe(runSnoozeKey(run.id));
    });

    it('offers the timed choices and "Until I unsnooze it" for a pipeline', () => {
        const ids = snoozeChoices('pipeline').map(choice => choice.id);
        expect(ids).toEqual(['hour', 'hours', 'tomorrow', 'week', 'forever']);
        expect(snoozeChoices('pull-request').map(choice => choice.id)).not.toContain('forever');
        expect(snoozeChoices('pipeline-run').map(choice => choice.id)).not.toContain('forever');
    });

    it('keeps a snooze with no end until the user removes it', () => {
        const snooze = makeSnooze('forever', {}, new Date(0));
        expect(snooze).toEqual({ at: 0, forever: true });
        expect(isSnooze(snooze)).toBe(true);
        expect(isSnoozeActive(snooze, {}, SNOOZE_KEEP_MS * 10)).toBe(true);
        expect(isSnoozeOld(snooze, SNOOZE_KEEP_MS * 10)).toBe(false);
        expect(nextSnoozeEnd({ a: snooze }, 1)).toBeUndefined();
        expect(snoozeText(snooze, new Date(0), undefined, 'pipeline')).toBe('until you unsnooze it');
    });

    it('keeps the pipeline in a snooze of a pipeline, so the Snoozed card can show it without a waiting run', () => {
        const pipeline = snoozedPipelineOf({
            ...run,
            pipeline: { id: 'github:o/app:workflow:5', url: 'https://github.com/o/app/actions/workflows/deploy.yml' }
        });
        expect(pipeline).toEqual({ name: 'Deploy', source: 'app', sourceTitle: 'o/app', url: 'https://github.com/o/app/actions/workflows/deploy.yml' });
        expect(snoozedPipelineOf(run)).toBeUndefined();
        const snooze = makeSnooze('forever', {}, new Date(0), pipeline);
        expect(snooze).toEqual({ at: 0, forever: true, pipeline });
        expect(isSnooze(snooze)).toBe(true);
        expect(makeSnooze('hour', {}, new Date(0), pipeline)).toEqual({ at: 0, until: 3600_000, pipeline });
        expect(isSnooze({ ...snooze, pipeline: { name: 'Deploy' } })).toBe(false);
        expect(isPipelineSnoozeKey(pipelineSnoozeKey('x'))).toBe(true);
        expect(isPipelineSnoozeKey(runSnoozeKey('x'))).toBe(false);
    });

    it('refuses a snooze with no end and a second end', () => {
        expect(isSnooze({ at: 1, forever: true, until: 2 })).toBe(false);
        expect(isSnooze({ at: 1, forever: true, activity: {} })).toBe(false);
        expect(isSnooze({ at: 1, forever: false })).toBe(false);
    });

    it('names the "activity" choice and its text for the subject', () => {
        expect(snoozeChoices('pull-request')[0].label).toBe('Until new activity');
        expect(snoozeChoices('pipeline-run')[0].label).toBe('Until the run changes');
        expect(snoozeChoices('pipeline-run').slice(1)).toEqual(snoozeChoices('pull-request').slice(1));
        expect(snoozeText({ at: 0, activity: {} }, new Date(0), undefined, 'pipeline-run')).toBe('until the run changes');
    });
});
