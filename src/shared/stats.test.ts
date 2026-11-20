import { describe, expect, it } from 'vitest';
import { linesToKeep, parseStatsLine, statsLine } from './stats';

describe('stats log lines', () => {
    it('writes an event as one JSON line with the version', () => {
        expect(statsLine({ type: 'merge', at: 5, number: 7, url: undefined })).toBe('{"v":1,"type":"merge","at":5,"number":7}\n');
    });

    it('reads only valid events', () => {
        expect(parseStatsLine(statsLine({ type: 'state', at: 1, session: 's', state: 'done' }))).toEqual({
            v: 1,
            type: 'state',
            at: 1,
            session: 's',
            state: 'done'
        });
        expect(parseStatsLine('')).toBeUndefined();
        expect(parseStatsLine('{"v":1,"type":"state","at":1')).toBeUndefined();
        expect(parseStatsLine('{"v":2,"type":"merge","at":1,"number":1}')).toBeUndefined();
        expect(parseStatsLine('{"v":1,"type":"merge","at":1}')).toBeUndefined();
        expect(parseStatsLine('{"v":1,"type":"compare","at":1,"compare":"c","runs":[]}')).toBeUndefined();
        expect(parseStatsLine('{"v":1,"type":"other","at":1}')).toBeUndefined();
        expect(parseStatsLine('[1]')).toBeUndefined();
    });

    it('keeps the lines at or after the time', () => {
        const text = ['{"v":1,"type":"merge","at":1,"number":1}', 'bad', '{"v":1,"type":"merge","at":5,"number":2}', ''].join('\n');
        expect(linesToKeep(text, 5)).toEqual(['{"v":1,"type":"merge","at":5,"number":2}']);
    });
});
