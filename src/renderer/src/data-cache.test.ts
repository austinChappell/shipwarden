import { describe, expect, it } from 'vitest';
import { cacheKey, cached, remember } from './data-cache';

describe('data cache', () => {
    it('returns the remembered value', () => {
        const value = [1, 2, 3];
        expect(remember('test.value', value)).toBe(value);
        expect(cached('test.value')).toBe(value);
    });

    it('returns undefined for an unknown key', () => {
        expect(cached('test.unknown')).toBeUndefined();
    });

    it('removes the oldest entry when it is full', () => {
        remember('test.oldest', 'a');
        remember('test.kept', 'b');
        for (let index = 0; index < 499; index++) remember(`test.fill.${index}`, index);
        expect(cached('test.oldest')).toBeUndefined();
        expect(cached('test.kept')).toBe('b');
    });

    it('makes different keys from different parts', () => {
        expect(cacheKey('a', 'b')).not.toBe(cacheKey('ab'));
        expect(cacheKey('a', undefined, 1)).toBe(cacheKey('a', null, '1'));
    });
});
