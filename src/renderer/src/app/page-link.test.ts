import { describe, expect, it } from 'vitest';
import { addPageLink, currentPageLink } from './page-link';

describe('currentPageLink', () => {
    it('returns undefined when no page gives a link', () => {
        expect(currentPageLink()).toBeUndefined();
    });

    it('returns the link of the page that opened last', () => {
        const removePr = addPageLink({ url: 'https://github.com/o/r/pull/1', kind: 'PR' });
        const removeTask = addPageLink({ url: 'https://app.clickup.com/t/1', kind: 'task' });
        expect(currentPageLink()?.kind).toBe('task');
        removeTask();
        expect(currentPageLink()?.kind).toBe('PR');
        removePr();
        expect(currentPageLink()).toBeUndefined();
    });

    it('removes only its own link, also when the remove function runs two times', () => {
        const remove = addPageLink({ url: 'a', kind: 'PR' });
        const removeOther = addPageLink({ url: 'b', kind: 'task' });
        remove();
        remove();
        expect(currentPageLink()?.url).toBe('b');
        removeOther();
    });
});
