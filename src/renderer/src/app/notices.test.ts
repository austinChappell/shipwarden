import { describe, expect, it } from 'vitest';
import { agentNotice, ciNotice, dashboardNotice } from './notices';

describe('agentNotice', () => {
    const session = { id: 's1', title: 'Claude Code', worktreePath: '/w' };

    it('names the agent by the task key, else the branch, else the session title', () => {
        expect(agentNotice(session, { taskKey: 'ENG-1', branch: 'main' }, 'waiting').title).toBe('ENG-1 needs your input');
        expect(agentNotice(session, { branch: 'feature' }, 'done').title).toBe('feature is done');
        expect(agentNotice(session, {}, 'done').title).toBe('Claude Code is done');
    });

    it('does not use the task key for a session without a worktree', () => {
        const notice = agentNotice({ id: 's1', title: 'shell' }, { taskKey: 'ENG-1' }, 'done');
        expect(notice.title).toBe('shell is done');
        expect(notice.target).toBeUndefined();
    });

    it('selects the event and the default text for each state', () => {
        const waiting = agentNotice(session, {}, 'waiting');
        expect(waiting.event).toBe('agentWaiting');
        expect(waiting.body).toBe('The agent waits for you.');
        const done = agentNotice(session, {}, 'done');
        expect(done.event).toBe('agentDone');
        expect(done.body).toBe('The agent finished its turn.');
    });

    it('cuts the message of the agent at 180 characters', () => {
        expect(agentNotice(session, {}, 'done', 'x'.repeat(300)).body).toHaveLength(180);
    });

    it('opens the agent tab of the worktree', () => {
        expect(agentNotice(session, {}, 'done').target).toEqual({ view: 'worktree', worktreePath: '/w', sessionId: 's1' });
    });
});

describe('dashboardNotice', () => {
    it('returns undefined when no item is new', () => {
        expect(dashboardNotice({ reviewRequests: 0, myPullRequests: 0, comments: 0 })).toBeUndefined();
    });

    it('counts each kind of item, with the singular and plural forms', () => {
        expect(dashboardNotice({ reviewRequests: 1, myPullRequests: 1, comments: 1 })?.title)
            .toBe('Dashboard: 1 review request, 1 of your pull requests needs you, 1 new comment');
        expect(dashboardNotice({ reviewRequests: 2, myPullRequests: 3, comments: 4 })?.title)
            .toBe('Dashboard: 2 review requests, 3 of your pull requests need you, 4 new comments');
    });

    it('shows the first title, else a default text', () => {
        expect(dashboardNotice({ reviewRequests: 1, myPullRequests: 0, comments: 0, firstTitle: 'Fix the build' })?.body).toBe('Fix the build');
        expect(dashboardNotice({ reviewRequests: 0, myPullRequests: 0, comments: 2 })?.body).toBe('Open the Dashboard to see them.');
    });

    it('opens the Dashboard', () => {
        const notice = dashboardNotice({ reviewRequests: 0, myPullRequests: 0, comments: 2 });
        expect(notice?.event).toBe('dashboard');
        expect(notice?.target).toEqual({ view: 'dashboard' });
    });
});

describe('ciNotice', () => {
    it('reports a pass or a failure of the checks', () => {
        expect(ciNotice('feature', true, 12, 'app', '/w')).toEqual({
            event: 'ciFinished',
            title: 'CI passed: feature',
            body: 'Pull request #12 in app',
            target: { view: 'worktree', worktreePath: '/w' }
        });
        expect(ciNotice('feature', false, 12, 'app', undefined).title).toBe('CI failed: feature');
    });

    it('has no target when no worktree has the branch', () => {
        expect(ciNotice('feature', false, 12, 'app', undefined).target).toBeUndefined();
    });
});
