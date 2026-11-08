import { afterEach, describe, expect, it } from 'vitest';
import { ScreenMirror } from './screen-mirror';

describe('ScreenMirror', () => {
    let mirror: ScreenMirror | undefined;
    afterEach(() => mirror?.dispose());

    const text = (line: { t: string }[]) => line.map(run => run.t).join('');

    it('gives the visible screen as runs of styled text', async () => {
        mirror = new ScreenMirror(20, 3);
        await mirror.write('plain \x1b[1;31mred\x1b[0m \x1b[38;2;1;2;3mrgb\x1b[0m\r\nnext');
        const snapshot = mirror.snapshot();
        expect(snapshot.cols).toBe(20);
        expect(snapshot.lines).toHaveLength(3);
        expect(snapshot.lines[0]).toEqual([{ t: 'plain ' }, { t: 'red', fg: 1, b: 1 }, { t: ' ' }, { t: 'rgb', fg: '#010203' }]);
        expect(text(snapshot.lines[1])).toBe('next');
        expect(snapshot.lines[2]).toEqual([]);
        expect(snapshot.cursor).toEqual({ x: 4, y: 1, visible: true });
    });

    it('includes the scrollback above the screen', async () => {
        mirror = new ScreenMirror(10, 2);
        await mirror.write('1\r\n2\r\n3\r\n4');
        expect(mirror.snapshot().lines.map(text)).toEqual(['1', '2', '3', '4']);
        expect(mirror.snapshot(1).lines.map(text)).toEqual(['2', '3', '4']);
    });

    it('ignores a chunk that it already has', async () => {
        mirror = new ScreenMirror(10, 2);
        await mirror.write('a', 1);
        await mirror.write('a', 1);
        await mirror.write('b', 2);
        expect(text(mirror.snapshot().lines[0])).toBe('ab');
    });

    it('follows the cursor visibility and the input modes of the program', async () => {
        mirror = new ScreenMirror(10, 2);
        expect(mirror.bracketedPaste).toBe(false);
        await mirror.write('\x1b[?25l\x1b[?2004h\x1b[?1h');
        expect(mirror.snapshot().cursor.visible).toBe(false);
        expect(mirror.bracketedPaste).toBe(true);
        expect(mirror.applicationCursorKeys).toBe(true);
        await mirror.write('\x1b[?25h');
        expect(mirror.snapshot().cursor.visible).toBe(true);
    });

    it('keeps wide characters as one character', async () => {
        mirror = new ScreenMirror(10, 1);
        await mirror.write('a界b');
        expect(text(mirror.snapshot().lines[0])).toBe('a界b');
    });
});
