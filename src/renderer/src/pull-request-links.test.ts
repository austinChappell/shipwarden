import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueReference } from '@shared/github';
import { openPullRequestLink, setPullRequestOpener } from './pull-request-links';
import { queryClient } from './query-client';

const PLAIN = { metaKey: false, ctrlKey: false, shiftKey: false };
const issueReference = vi.fn<(target: unknown, number: number) => Promise<IssueReference | null>>();
const openInBrowser = vi.fn();

beforeEach(() => {
    vi.stubGlobal('window', { shipwarden: { github: { issueReference, openInBrowser } } });
    queryClient.clear();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('openPullRequestLink', () => {
    it('opens a pull request address in ShipWarden on a plain click', () => {
        const open = vi.fn();
        const remove = setPullRequestOpener(open);
        expect(openPullRequestLink('https://github.com/acme/api/pull/5/files', PLAIN)).toBe(true);
        expect(open).toHaveBeenCalledWith({ owner: 'acme', name: 'api' }, 5, 'files');
        remove();
    });

    it('leaves ⌘-click, other addresses, and the time without a provider to the browser', () => {
        expect(openPullRequestLink('https://github.com/acme/api/pull/5', PLAIN)).toBe(false);
        const open = vi.fn();
        const remove = setPullRequestOpener(open);
        expect(openPullRequestLink('https://github.com/acme/api/pull/5', { ...PLAIN, metaKey: true })).toBe(false);
        expect(openPullRequestLink('https://github.com/acme/api', PLAIN)).toBe(false);
        expect(open).not.toHaveBeenCalled();
        remove();
    });

    it('opens a "#123" reference in ShipWarden when it is a pull request, and in the browser when it is an issue', async () => {
        const open = vi.fn();
        const remove = setPullRequestOpener(open);
        issueReference.mockResolvedValueOnce({ number: 8, title: 'Fix', kind: 'pullRequest', state: 'OPEN' });
        expect(openPullRequestLink('https://github.com/acme/api/issues/8', PLAIN)).toBe(true);
        await vi.waitFor(() => expect(open).toHaveBeenCalledWith({ owner: 'acme', name: 'api' }, 8, 'overview'));

        issueReference.mockResolvedValueOnce({ number: 9, title: 'Bug', kind: 'issue', state: 'OPEN' });
        expect(openPullRequestLink('https://github.com/acme/api/issues/9', PLAIN)).toBe(true);
        await vi.waitFor(() => expect(openInBrowser).toHaveBeenCalledWith('https://github.com/acme/api/issues/9'));
        expect(open).toHaveBeenCalledTimes(1);
        remove();
    });

    it('asks GitHub one time for each number', async () => {
        const open = vi.fn();
        const remove = setPullRequestOpener(open);
        issueReference.mockResolvedValue({ number: 8, title: 'Fix', kind: 'pullRequest', state: 'OPEN' });
        openPullRequestLink('https://github.com/acme/api/issues/8', PLAIN);
        await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
        openPullRequestLink('https://github.com/acme/api/issues/8', PLAIN);
        await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
        expect(issueReference).toHaveBeenCalledTimes(1);
        remove();
    });
});
