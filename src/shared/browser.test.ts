import { describe, expect, it } from 'vitest';
import { browserTabTitle, isBrowsableUrl, linkTarget, normalizeAddress, SEARCH_URL } from './browser';

describe('normalizeAddress', () => {
    it('keeps http and https addresses', () => {
        expect(normalizeAddress('https://github.com/a/b')).toBe('https://github.com/a/b');
        expect(normalizeAddress('  HTTP://Example.com  ')).toBe('http://example.com/');
    });

    it('adds http to local hosts', () => {
        expect(normalizeAddress('localhost:3000')).toBe('http://localhost:3000/');
        expect(normalizeAddress('localhost')).toBe('http://localhost/');
        expect(normalizeAddress('127.0.0.1:8080/api')).toBe('http://127.0.0.1:8080/api');
        expect(normalizeAddress('192.168.1.20')).toBe('http://192.168.1.20/');
        expect(normalizeAddress('app.localhost:5173')).toBe('http://app.localhost:5173/');
        expect(normalizeAddress('8.8.8.8')).toBe('http://8.8.8.8/');
    });

    it('adds https to a domain', () => {
        expect(normalizeAddress('github.com')).toBe('https://github.com/');
        expect(normalizeAddress('docs.github.com/en?x=1')).toBe('https://docs.github.com/en?x=1');
        expect(normalizeAddress('example.com:8443')).toBe('https://example.com:8443/');
    });

    it('searches for other text', () => {
        expect(normalizeAddress('electron webcontentsview')).toBe(`${SEARCH_URL}electron%20webcontentsview`);
        expect(normalizeAddress('vitest')).toBe(`${SEARCH_URL}vitest`);
        expect(normalizeAddress('version 1.2')).toBe(`${SEARCH_URL}version%201.2`);
    });

    it('refuses an empty text and other schemes', () => {
        expect(normalizeAddress('   ')).toBeUndefined();
        expect(normalizeAddress('file:///etc/passwd')).toBeUndefined();
        expect(normalizeAddress('javascript:alert(1)')).toBeUndefined();
        expect(normalizeAddress('chrome://settings')).toBeUndefined();
    });

    it('keeps the blank page', () => {
        expect(normalizeAddress('about:blank')).toBe('about:blank');
    });
});

describe('isBrowsableUrl', () => {
    it('permits only http, https and the blank page', () => {
        expect(isBrowsableUrl('https://a.b/')).toBe(true);
        expect(isBrowsableUrl('http://localhost:3000')).toBe(true);
        expect(isBrowsableUrl('about:blank')).toBe(true);
        expect(isBrowsableUrl('file:///tmp/x')).toBe(false);
        expect(isBrowsableUrl('mailto:a@b.c')).toBe(false);
        expect(isBrowsableUrl('not a url')).toBe(false);
    });
});

describe('linkTarget', () => {
    const click = (keys: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) => ({
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        ...keys
    });

    it('opens the in-app browser for ⇧⌘-click', () => {
        expect(linkTarget(click({ metaKey: true, shiftKey: true }))).toBe('app');
        expect(linkTarget(click({ metaKey: true, shiftKey: true }), { needsModifier: true })).toBe('app');
    });

    it('opens the default browser for ⌘-click', () => {
        expect(linkTarget(click({ metaKey: true }))).toBe('system');
        expect(linkTarget(click({ metaKey: true }), { needsModifier: true })).toBe('system');
    });

    it('opens the default browser for a plain click, except in the terminal', () => {
        expect(linkTarget(click())).toBe('system');
        expect(linkTarget(undefined)).toBe('system');
        expect(linkTarget(click(), { needsModifier: true })).toBe('none');
        expect(linkTarget(click({ shiftKey: true }), { needsModifier: true })).toBe('none');
    });

    it('uses Ctrl instead of ⌘ on other systems', () => {
        expect(linkTarget(click({ ctrlKey: true, shiftKey: true }), { isMac: false })).toBe('app');
        expect(linkTarget(click({ ctrlKey: true }), { isMac: false, needsModifier: true })).toBe('system');
        expect(linkTarget(click({ ctrlKey: true, shiftKey: true }), { needsModifier: true })).toBe('none');
    });
});

describe('browserTabTitle', () => {
    it('uses the title, else the host, else "New tab"', () => {
        expect(browserTabTitle({ title: 'GitHub', url: 'https://github.com/' })).toBe('GitHub');
        expect(browserTabTitle({ title: '', url: 'http://localhost:3000/x' })).toBe('localhost:3000');
        expect(browserTabTitle({ title: 'https://a.b/', url: 'https://a.b/' })).toBe('a.b');
        expect(browserTabTitle({ title: '', url: 'about:blank' })).toBe('New tab');
        expect(browserTabTitle(undefined)).toBe('New tab');
    });
});
