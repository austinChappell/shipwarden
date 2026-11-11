import { describe, expect, it } from 'vitest';
import { userDataOverride } from './user-data';

describe('userDataOverride', () => {
    const cwd = '/Users/me/code/shipwarden';
    const home = '/Users/me';

    it('returns undefined when the variable is empty or not set', () => {
        expect(userDataOverride({}, cwd, home)).toBeUndefined();
        expect(userDataOverride({ SHIPWARDEN_USER_DATA_DIR: '  ' }, cwd, home)).toBeUndefined();
    });

    it('returns an absolute path', () => {
        expect(userDataOverride({ SHIPWARDEN_USER_DATA_DIR: '/tmp/sw-fresh/' }, cwd, home)).toBe('/tmp/sw-fresh');
        expect(userDataOverride({ SHIPWARDEN_USER_DATA_DIR: 'tmp/fresh' }, cwd, home)).toBe('/Users/me/code/shipwarden/tmp/fresh');
    });

    it('changes a leading "~" to the home folder', () => {
        expect(userDataOverride({ SHIPWARDEN_USER_DATA_DIR: '~/sw-fresh' }, cwd, home)).toBe('/Users/me/sw-fresh');
        expect(userDataOverride({ SHIPWARDEN_USER_DATA_DIR: '~' }, cwd, home)).toBe('/Users/me');
    });
});
