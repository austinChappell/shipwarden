import { describe, expect, it } from 'vitest';
import { popoverPosition } from './Popover';
import { nextEnabled, typeAheadIndex } from './Select';

describe('Select', () => {
    const options = [{ label: 'backlog' }, { label: 'blocked', disabled: true }, { label: 'in review' }, { label: 'in progress' }];

    it('finds the next option for the typed letters', () => {
        expect(typeAheadIndex(options, 'b', 1)).toBe(0);
        expect(typeAheadIndex(options, 'in', 0)).toBe(2);
        expect(typeAheadIndex(options, 'i', 3)).toBe(3);
        expect(typeAheadIndex(options, 'x', 0)).toBe(-1);
    });

    it('skips the disabled options', () => {
        expect(nextEnabled(options, 0, 1)).toBe(2);
        expect(nextEnabled(options, 2, -1)).toBe(0);
        expect(nextEnabled(options, 3, 1)).toBe(3);
    });
});

describe('popoverPosition', () => {
    const window = { width: 1000, height: 800 };

    it('puts the popover below the anchor when it fits', () => {
        expect(popoverPosition({ top: 100, bottom: 130, left: 50, width: 120 }, { width: 200, height: 300 }, window)).toMatchObject({
            top: 134,
            left: 50,
            minWidth: 120
        });
    });

    it('puts the popover above the anchor when the space below is too small', () => {
        const style = popoverPosition({ top: 700, bottom: 730, left: 950, width: 40 }, { width: 200, height: 300 }, window);
        expect(style).toMatchObject({ bottom: 104, left: 792 });
    });
});
