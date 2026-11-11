import { describe, expect, it } from 'vitest';
import { labelRows, labelSummary } from './LabelFilterPicker';

const labels = [{ name: 'Bug', color: '#f00' }, { name: 'UI' }];

describe('labelSummary', () => {
    it.each([
        [{ labels: [], unlabeled: false }, 'All labels'],
        [{ labels: ['bug'], unlabeled: false }, 'Bug'],
        [{ labels: ['ui', 'bug'], unlabeled: true }, 'UI +2'],
        [{ labels: [], unlabeled: true }, 'No labels'],
        [{ labels: ['docs'], unlabeled: false }, 'docs']
    ])('gives the button text for %j', (value, expected) => {
        expect(labelSummary(value, labels)).toBe(expected);
    });
});

describe('labelRows', () => {
    it('keeps a selected label that no loaded task has', () => {
        expect(labelRows({ labels: ['docs', 'bug'], unlabeled: false }, labels)).toEqual([
            { key: 'bug', name: 'Bug', color: '#f00' },
            { key: 'ui', name: 'UI', color: undefined },
            { key: 'docs', name: 'docs' }
        ]);
    });
});
