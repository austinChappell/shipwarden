import { describe, expect, it } from 'vitest';
import { initials, splitFooter } from './pr-description';

describe('splitFooter', () => {
    it('moves the "Generated with" line to the footer', () => {
        const body = '## The issue\n\nText.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n';
        expect(splitFooter(body)).toEqual({ text: '## The issue\n\nText.', footer: 'Generated with [Claude Code](https://claude.com/claude-code)' });
    });

    it('keeps a body without the line', () => {
        expect(splitFooter('Only text.')).toEqual({ text: 'Only text.', footer: null });
    });

    it('keeps the line when it is not the last line', () => {
        const body = 'Generated with care.\n\nMore text.';
        expect(splitFooter(body)).toEqual({ text: body, footer: null });
    });

    it('gives an empty text when the body has only the line', () => {
        expect(splitFooter('Generated with [Claude Code](https://claude.com/claude-code)')).toEqual({
            text: '',
            footer: 'Generated with [Claude Code](https://claude.com/claude-code)'
        });
    });
});

describe('initials', () => {
    it('uses the first letters of the words of a login', () => {
        expect(initials('austinChappell')).toBe('AC');
        expect(initials('m2-mathew')).toBe('MM');
    });

    it('uses the first two letters of a login with one word', () => {
        expect(initials('codecov')).toBe('CO');
    });
});
