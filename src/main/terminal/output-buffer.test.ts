import { describe, expect, it } from 'vitest';
import { OutputBuffer } from './output-buffer';

describe('OutputBuffer', () => {
    it('gives each chunk the next sequence number', () => {
        const buffer = new OutputBuffer();
        expect(buffer.append('a')).toBe(1);
        expect(buffer.append('b')).toBe(2);
        expect(buffer.replay()).toEqual({ data: 'ab', seq: 2 });
    });

    it('removes the oldest chunks when the size is more than the limit', () => {
        const buffer = new OutputBuffer(5);
        buffer.append('aaa');
        buffer.append('bbb');
        buffer.append('cc');
        expect(buffer.replay()).toEqual({ data: 'bbbcc', seq: 3 });
    });

    it('keeps the last chunk when that chunk alone is more than the limit', () => {
        const buffer = new OutputBuffer(2);
        buffer.append('long chunk');
        expect(buffer.replay().data).toBe('long chunk');
    });
});
