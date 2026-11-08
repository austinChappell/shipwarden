import { describe, expect, it } from 'vitest';
import { fixedStart } from './DashboardSettings';

describe('fixedStart', () => {
    it('keeps the words before the first word with a digit', () => {
        expect(fixedStart('Linked to ClickUp task: ABC-1234')).toBe('Linked to ClickUp task:');
        expect(fixedStart('Pull request #3915 opened in GitHub')).toBe('Pull request');
    });

    it('keeps the first line when the variable part starts too early', () => {
        expect(fixedStart('PR #12 is ready\nmore text')).toBe('PR #12 is ready');
        expect(fixedStart('Looks good to me')).toBe('Looks good to me');
    });
});
