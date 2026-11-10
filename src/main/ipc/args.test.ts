import { describe, expect, it } from 'vitest';
import type { HookSettingsPaths } from '@shared/agents';
import {
    changed, DEFAULT_LOG_LIMIT, FETCH_INTERVAL_MS, fetchMaxAge, isWebUrl, logLimit, newPullRequestOf, onlyStrings, optionalString,
    repoRefOf, sameRepo, stringsOf, terminalCommand, validBounds
} from './args';

describe('stringsOf', () => {
    it('makes each item a string', () => {
        expect(stringsOf(['a', 1, true])).toEqual(['a', '1', 'true']);
    });
    it('gives an empty list for a value that is not an array', () => {
        expect(stringsOf('a')).toEqual([]);
        expect(stringsOf(undefined)).toEqual([]);
    });
});

describe('onlyStrings', () => {
    it('keeps only the string items', () => {
        expect(onlyStrings(['a', 1, null, 'b'])).toEqual(['a', 'b']);
    });
    it('gives an empty list for a value that is not an array', () => {
        expect(onlyStrings({ 0: 'a' })).toEqual([]);
    });
});

describe('optionalString', () => {
    it('keeps a string, also an empty string', () => {
        expect(optionalString('org')).toBe('org');
        expect(optionalString('')).toBe('');
    });
    it('gives undefined for other values', () => {
        expect(optionalString(5)).toBeUndefined();
        expect(optionalString(null)).toBeUndefined();
    });
});

describe('validBounds', () => {
    it('keeps four finite numbers', () => {
        expect(validBounds({ x: 1, y: 2, width: 300, height: 400 })).toEqual({ x: 1, y: 2, width: 300, height: 400 });
    });
    it('removes other fields', () => {
        expect(validBounds({ x: 0, y: 0, width: 1, height: 1, extra: 'value' })).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    });
    it.each([
        [null],
        [undefined],
        ['bounds'],
        [{ x: 1, y: 2, width: 300 }],
        [{ x: 1, y: 2, width: '300', height: 400 }],
        [{ x: Number.NaN, y: 2, width: 300, height: 400 }],
        [{ x: 1, y: Number.POSITIVE_INFINITY, width: 300, height: 400 }]
    ])('gives null for %j', bounds => {
        expect(validBounds(bounds)).toBeNull();
    });
});

describe('isWebUrl', () => {
    it('accepts http and https URLs', () => {
        expect(isWebUrl('https://github.com/acme/api')).toBe(true);
        expect(isWebUrl('http://localhost:3000')).toBe(true);
    });
    it('rejects other schemes and other values', () => {
        expect(isWebUrl('file:///etc/passwd')).toBe(false);
        expect(isWebUrl('javascript:alert(1)')).toBe(false);
        expect(isWebUrl('https:no-slashes')).toBe(false);
        expect(isWebUrl(undefined)).toBe(false);
    });
});

describe('newPullRequestOf', () => {
    it('trims the title and keeps the base', () => {
        expect(newPullRequestOf({ title: '  Fix the bug ', body: 'Text', base: 'develop', draft: true }))
            .toEqual({ title: 'Fix the bug', body: 'Text', base: 'develop', draft: true });
    });
    it('gives defaults for missing and wrong fields', () => {
        expect(newPullRequestOf(undefined)).toEqual({ title: '', body: '', base: undefined, draft: false });
        expect(newPullRequestOf({ title: 'A', base: '', draft: 'yes' as unknown as boolean }))
            .toEqual({ title: 'A', body: '', base: undefined, draft: false });
    });
});

describe('repoRefOf', () => {
    it('gives string fields', () => {
        expect(repoRefOf({ owner: 'acme', name: 'api' })).toEqual({ owner: 'acme', name: 'api' });
        expect(repoRefOf(undefined)).toEqual({ owner: '', name: '' });
    });
});

describe('sameRepo', () => {
    it('ignores the case of the names', () => {
        expect(sameRepo({ owner: 'Acme', name: 'API' }, { owner: 'acme', name: 'api' })).toBe(true);
    });
    it('compares the owner and the name', () => {
        expect(sameRepo({ owner: 'acme', name: 'api' }, { owner: 'acme', name: 'web' })).toBe(false);
        expect(sameRepo({ owner: 'acme', name: 'api' }, { owner: 'other', name: 'api' })).toBe(false);
    });
});

describe('logLimit', () => {
    it('keeps a finite number', () => {
        expect(logLimit(50)).toBe(50);
    });
    it('gives the default limit for other values', () => {
        expect(logLimit('50')).toBe(DEFAULT_LOG_LIMIT);
        expect(logLimit(Number.NaN)).toBe(DEFAULT_LOG_LIMIT);
        expect(logLimit(undefined)).toBe(300);
    });
});

describe('fetchMaxAge', () => {
    it('gives 0 only for true', () => {
        expect(fetchMaxAge(true)).toBe(0);
        expect(fetchMaxAge('true')).toBe(FETCH_INTERVAL_MS);
        expect(fetchMaxAge(undefined)).toBe(5 * 60 * 1000);
    });
});

describe('terminalCommand', () => {
    const paths: HookSettingsPaths = { claude: '/data/claude-hooks.json', gemini: '/data/gemini-hooks.json', opencode: '/data/opencode/plugin.js' };

    it('adds the hook settings to an agent command', () => {
        const result = terminalCommand({ command: 'claude', isAgent: true }, paths);
        expect(result.command).toContain('--settings');
        expect(result.command).toContain('/data/claude-hooks.json');
        expect(result.reportsAgentState).toBe(true);
    });
    it('does not change the command of a shell', () => {
        expect(terminalCommand({ command: 'claude', isAgent: false }, paths)).toEqual({ command: 'claude', reportsAgentState: false });
        expect(terminalCommand({ isAgent: false }, paths)).toEqual({ command: undefined, reportsAgentState: false });
    });
    it('gives no agent state to an agent without hooks', () => {
        expect(terminalCommand({ command: 'aider', isAgent: true }, paths)).toEqual({ command: 'aider', reportsAgentState: false });
    });
});

describe('changed', () => {
    it('compares the JSON text', () => {
        expect(changed({ a: 1 }, { a: 1 })).toBe(false);
        expect(changed({ a: 1 }, { a: 2 })).toBe(true);
        expect(changed(undefined, {})).toBe(true);
    });
});
