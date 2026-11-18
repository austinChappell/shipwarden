import { describe, expect, it } from 'vitest';
import { HyperlinkFilter } from './hyperlinks';

const linkBel = (url: string, text: string) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
const linkSt = (url: string, text: string) => `\x1b]8;id=7;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

/** Sends the data to a new filter in chunks of `size` characters and joins the output. */
function filterInChunks(data: string, size: number): string {
    const filter = new HyperlinkFilter();
    let out = '';
    for (let index = 0; index < data.length; index += size) {
        out += filter.filter(data.slice(index, index + size));
    }
    return out;
}

describe('HyperlinkFilter', () => {
    it('removes a link that ends with BEL and keeps its text', () => {
        expect(new HyperlinkFilter().filter(`see ${linkBel('file:///a/b.ts', 'src/b.ts')} now`)).toBe('see src/b.ts now');
    });

    it('removes a link that ends with ESC \\ and has params', () => {
        expect(new HyperlinkFilter().filter(`see ${linkSt('https://github.com/a/b/pull/1', '#1')} now`)).toBe('see #1 now');
    });

    it('keeps the other escape sequences', () => {
        const data = `\x1b[31mred\x1b[0m \x1b]0;title\x07${linkBel('file:///x', 'x')}\x1b[?1049h\x1b[2K\x1b\\`;
        expect(new HyperlinkFilter().filter(data)).toBe('\x1b[31mred\x1b[0m \x1b]0;title\x07x\x1b[?1049h\x1b[2K\x1b\\');
    });

    it('keeps an OSC with a number that starts with 8', () => {
        expect(new HyperlinkFilter().filter('\x1b]80;x\x07a')).toBe('\x1b]80;x\x07a');
    });

    it('gives the same result for each chunk size', () => {
        const data = Array.from(
            { length: 20 },
            (_, i) => `line ${i} \x1b[1m${linkBel(`file:///x${i}`, `f${i}.ts`)}\x1b[0m ${linkSt(`https://x.y/${i}`, `u${i}`)} 👍🏽\r\n`
        ).join('');
        const expected = Array.from({ length: 20 }, (_, i) => `line ${i} \x1b[1mf${i}.ts\x1b[0m u${i} 👍🏽\r\n`).join('');
        for (const size of [1, 2, 3, 4, 5, 7, 16, 64, data.length]) {
            expect(filterInChunks(data, size)).toBe(expected);
        }
    });

    it('holds an ESC at the end of a chunk until the next chunk', () => {
        const filter = new HyperlinkFilter();
        expect(filter.filter('a\x1b')).toBe('a');
        expect(filter.filter('[0mb')).toBe('\x1b[0mb');
    });

    it('ends a link sequence at an ESC that does not start ST, and keeps that escape sequence', () => {
        expect(new HyperlinkFilter().filter('\x1b]8;;file:///a\x1b[31mred')).toBe('\x1b[31mred');
    });
});
