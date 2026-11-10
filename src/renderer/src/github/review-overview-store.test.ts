import { describe, expect, it } from 'vitest';
import type { PullRequest } from '@shared/github';
import type { OpenPullRequest, RepoPullRequests } from '@shared/review-queue';
import { asMerged, createLimiter, uniqueRepoIds, withoutOpenPullRequest } from './review-overview-store';

describe('createLimiter', () => {
    it('runs not more than the limit of tasks at the same time, in order', async () => {
        const limit = createLimiter(2);
        let running = 0;
        let most = 0;
        const order: number[] = [];
        const task = (id: number) => async () => {
            running++;
            most = Math.max(most, running);
            await new Promise(resolve => setTimeout(resolve, 5));
            order.push(id);
            running--;
            return id;
        };
        const results = await Promise.all([1, 2, 3, 4, 5].map(id => limit(task(id))));
        expect(results).toEqual([1, 2, 3, 4, 5]);
        expect(most).toBe(2);
        expect(order).toHaveLength(5);
    });

    it('starts the next task after a task fails', async () => {
        const limit = createLimiter(1);
        const failed = limit(() => Promise.reject(new Error('no')));
        const next = limit(() => Promise.resolve('yes'));
        await expect(failed).rejects.toThrow('no');
        await expect(next).resolves.toBe('yes');
    });
});

describe('uniqueRepoIds', () => {
    it('removes duplicates of any case and keeps the first spelling', () => {
        expect(uniqueRepoIds(['Acme/App', 'acme/app', 'acme/web'])).toEqual(['Acme/App', 'acme/web']);
    });
});

describe('withoutOpenPullRequest', () => {
    const data = { viewer: 'me', openCount: 5, pullRequests: [{ number: 1 }, { number: 2 }] as OpenPullRequest[] } as RepoPullRequests;

    it('removes the pull request and decreases the open count', () => {
        const result = withoutOpenPullRequest(data, 2);
        expect(result.pullRequests.map(pr => pr.number)).toEqual([1]);
        expect(result.openCount).toBe(4);
    });

    it('returns the same data when the list does not have the pull request', () => {
        expect(withoutOpenPullRequest(data, 9)).toBe(data);
    });
});

describe('asMerged', () => {
    it('sets the state MERGED', () => {
        expect(asMerged({ number: 1, state: 'OPEN' } as PullRequest).state).toBe('MERGED');
    });
});
