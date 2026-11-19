// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { findTextRanges } from './dom-find';

beforeAll(() => {
    // jsdom has no layout. An element with the "hidden" attribute has no box, as in a browser.
    Element.prototype.getClientRects = function (this: Element) {
        const rects = this.closest('[hidden]') ? [] : [{}];
        return rects as unknown as DOMRectList;
    };
});

function root(html: string): HTMLElement {
    const element = document.createElement('div');
    element.innerHTML = html;
    document.body.replaceChildren(element);
    return element;
}

describe('findTextRanges', () => {
    it('finds all matches and ignores the case', () => {
        const ranges = findTextRanges(root('<p>Error one</p><p>error two</p>'), 'error', false);
        expect(ranges.map(range => range.toString())).toEqual(['Error', 'error']);
    });

    it('matches the case when the search asks for it', () => {
        expect(findTextRanges(root('<p>Error error</p>'), 'error', true)).toHaveLength(1);
    });

    it('finds a match across elements', () => {
        const ranges = findTextRanges(root('<p>run <code>npm</code> test</p>'), 'run npm t', false);
        expect(ranges.map(range => range.toString())).toEqual(['run npm t']);
    });

    it('does not find text in a field or in a hidden element', () => {
        const element = root('<p>alpha</p><textarea>alpha</textarea><div hidden>alpha</div>');
        expect(findTextRanges(element, 'alpha', false)).toHaveLength(1);
    });

    it('gives no ranges for an empty search', () => {
        expect(findTextRanges(root('<p>alpha</p>'), '', false)).toEqual([]);
    });
});
