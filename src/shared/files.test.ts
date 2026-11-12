import { describe, expect, it } from 'vitest';
import { fileNameError, freeName, isSameOrInside, joinPath } from './files';

describe('fileNameError', () => {
    it('accepts normal names and refuses names that are not valid', () => {
        expect(fileNameError('index.ts')).toBeUndefined();
        expect(fileNameError('.env.local')).toBeUndefined();
        expect(fileNameError('')).toBe('Type a name.');
        expect(fileNameError('a/b')).toBe('The name must not contain "/".');
        expect(fileNameError('a/b', true)).toBeUndefined();
        expect(fileNameError('a//b', true)).toBeDefined();
        expect(fileNameError('..')).toBeDefined();
        expect(fileNameError('.git')).toBeDefined();
    });
});

describe('freeName', () => {
    it('adds " copy" and a number like the Finder', () => {
        expect(freeName('a.ts', new Set())).toBe('a.ts');
        expect(freeName('a.ts', new Set(['a.ts']))).toBe('a copy.ts');
        expect(freeName('a.ts', new Set(['a.ts', 'a copy.ts']))).toBe('a copy 2.ts');
        expect(freeName('.env', new Set(['.env']))).toBe('.env copy');
        expect(freeName('src', new Set(['src']))).toBe('src copy');
    });
});

describe('paths', () => {
    it('joins paths and tests whether a path is in a folder', () => {
        expect(joinPath('', 'a')).toBe('a');
        expect(joinPath('src', 'a')).toBe('src/a');
        expect(isSameOrInside('src', 'src/a.ts')).toBe(true);
        expect(isSameOrInside('src', 'src')).toBe(true);
        expect(isSameOrInside('src', 'srcx/a.ts')).toBe(false);
        expect(isSameOrInside('', 'a')).toBe(true);
    });
});
