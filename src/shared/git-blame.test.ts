import { describe, expect, it } from 'vitest';
import { blameDate, parseBlamePorcelain, UNCOMMITTED_HASH } from './git-blame';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('parseBlamePorcelain', () => {
    it('reads the commit of each line, with the headers only on the first line of a commit', () => {
        const output = [
            `${A} 1 1 2`,
            'author Ada',
            'author-mail <ada@example.com>',
            'author-time 1700000000',
            'author-tz +0000',
            'summary First commit',
            'boundary',
            'filename a.txt',
            '\tone',
            `${A} 2 2`,
            '\ttwo',
            `${UNCOMMITTED_HASH} 3 3 1`,
            'author Not Committed Yet',
            'author-mail <not.committed.yet>',
            'author-time 1700000100',
            'summary Version of a.txt from a.txt',
            'previous ' + B + ' a.txt',
            'filename a.txt',
            '\t\tthree with a tab',
            `${A} 3 4 1`,
            'filename a.txt',
            '\tfour',
            ''
        ].join('\n');
        const blame = parseBlamePorcelain(output);
        expect(blame.lines).toEqual([A, A, UNCOMMITTED_HASH, A]);
        expect(blame.commits[A]).toEqual({
            hash: A,
            author: 'Ada',
            authorEmail: 'ada@example.com',
            date: 1700000000000,
            summary: 'First commit',
            uncommitted: false
        });
        expect(blame.commits[UNCOMMITTED_HASH].uncommitted).toBe(true);
    });

    it('reads an empty file', () => {
        expect(parseBlamePorcelain('')).toEqual({ commits: {}, lines: [] });
    });
});

describe('blameDate', () => {
    it('shows the local date as YYYY-MM-DD', () => {
        expect(blameDate(new Date(2026, 0, 5, 12).getTime())).toBe('2026-01-05');
    });
});
