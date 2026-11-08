import { describe, expect, it } from 'vitest';
import { extractMarkedPath, mergePath } from './shell-env';

describe('mergePath', () => {
    it('puts the first entries first and removes duplicates', () => {
        expect(mergePath('/a:/b', '/b:/c')).toBe('/a:/b:/c');
        expect(mergePath('', '/usr/bin')).toBe('/usr/bin');
    });
});

describe('extractMarkedPath', () => {
    it('ignores the text that startup files print', () => {
        expect(extractMarkedPath('Welcome!\n__SHIPWARDEN_PATH__/x:/y__SHIPWARDEN_PATH__')).toBe('/x:/y');
    });

    it('reads a value between other markers', () => {
        expect(extractMarkedPath('__A__/x__A____B__/ca.pem__B__', '__B__')).toBe('/ca.pem');
        expect(extractMarkedPath('__A__/x__A____B____B__', '__B__')).toBe('');
    });

    it('returns undefined when the markers are missing', () => {
        expect(extractMarkedPath('no markers')).toBeUndefined();
    });
});
