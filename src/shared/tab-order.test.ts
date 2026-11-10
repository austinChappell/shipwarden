import { describe, expect, it } from 'vitest';
import { moveStripEntry, orderTabs } from './tab-order';

describe('orderTabs', () => {
    it('keeps the given order without a saved order', () => {
        expect(orderTabs(['t:1', 'f:a', 'd:b'], undefined)).toEqual(['t:1', 'f:a', 'd:b']);
        expect(orderTabs(['t:1', 'f:a'], [])).toEqual(['t:1', 'f:a']);
    });

    it('uses the saved order and puts new tabs at the end', () => {
        expect(orderTabs(['t:1', 'f:a', 'd:b'], ['d:b', 't:1', 'f:a'])).toEqual(['d:b', 't:1', 'f:a']);
        expect(orderTabs(['t:1', 'f:a', 't:2'], ['f:a', 't:1'])).toEqual(['f:a', 't:1', 't:2']);
    });

    it('ignores saved keys of closed tabs', () => {
        expect(orderTabs(['t:1', 'f:a'], ['f:gone', 'f:a', 't:1'])).toEqual(['f:a', 't:1']);
    });
});

describe('moveStripEntry', () => {
    it('moves a tab one step', () => {
        expect(moveStripEntry([['a'], ['b'], ['c']], 0, 1)).toEqual(['b', 'a', 'c']);
        expect(moveStripEntry([['a'], ['b'], ['c']], 2, -1)).toEqual(['a', 'c', 'b']);
    });

    it('moves a split tab with all its panes', () => {
        expect(moveStripEntry([['a'], ['b', 'c'], ['d']], 1, -1)).toEqual(['b', 'c', 'a', 'd']);
        expect(moveStripEntry([['a'], ['b', 'c'], ['d']], 0, 1)).toEqual(['b', 'c', 'a', 'd']);
    });

    it('does not move past the ends of the strip', () => {
        expect(moveStripEntry([['a'], ['b']], 0, -1)).toBeUndefined();
        expect(moveStripEntry([['a'], ['b']], 1, 1)).toBeUndefined();
        expect(moveStripEntry([['a']], 5, -1)).toBeUndefined();
    });
});
