import { describe, expect, it } from 'vitest';
import type { BranchSummary } from '@shared/github';
import { SummaryPoller } from './summary-poller';

function summary(checks: string): BranchSummary {
    return { number: 1, url: 'https://github.com/o/r/pull/1', isDraft: false, reviewDecision: null, checks };
}

describe('SummaryPoller', () => {
    it('sends one request for each repository and keeps the newest summaries', async () => {
        const requests: string[] = [];
        const received: string[][] = [];
        let repos = ['/a', '/b'];
        const poller = new SummaryPoller({
            repos: async () => repos,
            fetch: async repo => {
                requests.push(repo);
                if (repo === '/b') throw new Error('rate limit');
                return { main: summary('PENDING') };
            },
            onSummaries: summaries => {
                received.push(Object.keys(summaries));
            }
        });
        await poller.poll();
        expect(requests).toEqual(['/a', '/b']);
        expect(received).toEqual([['/a']]);
        expect(Object.keys(poller.summaries())).toEqual(['/a']);
        repos = [];
        await poller.poll();
        expect(requests).toHaveLength(2);
        expect(poller.summaries()).toEqual({});
        expect(received).toHaveLength(1);
    });

    it('runs one poll at a time', async () => {
        let calls = 0;
        const poller = new SummaryPoller({
            repos: async () => ['/a'],
            fetch: async () => {
                calls += 1;
                await new Promise(done => setTimeout(done, 10));
                return {};
            },
            onSummaries: () => undefined
        });
        await Promise.all([poller.poll(), poller.poll()]);
        expect(calls).toBe(1);
    });
});
