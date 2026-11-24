import { describe, expect, it } from 'vitest';
import { isValidCliAlias, normalizeCliAlias } from './cli';
import { normalizeSettings } from './settings';

describe('isValidCliAlias', () => {
    it('accepts short command names', () => {
        expect(isValidCliAlias('sw')).toBe(true);
        expect(isValidCliAlias('ship-w.2_x')).toBe(true);
    });

    it('refuses empty names, paths, spaces, and "shipwarden"', () => {
        for (const name of ['', '-sw', 'a/b', 'a b', '../sw', 'shipwarden', 'x'.repeat(33)]) expect(isValidCliAlias(name)).toBe(false);
    });
});

describe('normalizeCliAlias', () => {
    it('gives "sw", on, to a new installation', () => {
        expect(normalizeCliAlias(undefined)).toEqual({ enabled: true, name: 'sw' });
        expect(normalizeSettings({}).cliAlias).toEqual({ enabled: true, name: 'sw' });
    });

    it('keeps a valid name and the off state', () => {
        expect(normalizeCliAlias({ enabled: false, name: ' ship ' })).toEqual({ enabled: false, name: 'ship' });
    });

    it('replaces a name that is not valid with "sw"', () => {
        expect(normalizeCliAlias({ enabled: true, name: 'a/b' })).toEqual({ enabled: true, name: 'sw' });
    });
});
