import { describe, expect, it } from 'vitest';
import {
    normalizeScreenshotSettings,
    pageSlug,
    pageUrl,
    parsePages,
    parseWait,
    screenshotCommentMarkdown,
    screenshotSettingsInput,
    uploadFileName,
    validateScreenshotSettings,
    type ScreenshotSet
} from './screenshots';

const input = (change: Partial<Record<'previewUrl' | 'pages' | 'wait' | 'viewportWidth', string>> = {}) => ({
    previewUrl: 'http://localhost:3000',
    pages: '/\n/settings',
    wait: '',
    viewportWidth: '',
    ...change
});

describe('validateScreenshotSettings', () => {
    it('accepts a preview URL and pages', () => {
        expect(validateScreenshotSettings(input())).toEqual({ errors: [], settings: { previewUrl: 'http://localhost:3000', pages: ['/', '/settings'] } });
    });

    it('treats an empty form as no settings', () => {
        expect(validateScreenshotSettings(input({ previewUrl: '', pages: '' }))).toEqual({ errors: [] });
    });

    it('removes the slash at the end of the preview URL, empty lines, and duplicate pages', () => {
        const result = validateScreenshotSettings(input({ previewUrl: 'https://app.local:8080/', pages: '/a\n\n /a \n/b' }));
        expect(result.settings).toEqual({ previewUrl: 'https://app.local:8080', pages: ['/a', '/b'] });
    });

    it('keeps the wait and a width that is not the default', () => {
        expect(validateScreenshotSettings(input({ wait: '#app', viewportWidth: '390' })).settings).toMatchObject({ wait: '#app', viewportWidth: 390 });
        expect(validateScreenshotSettings(input({ viewportWidth: '1280' })).settings).not.toHaveProperty('viewportWidth');
    });

    it('refuses a missing or wrong preview URL', () => {
        expect(validateScreenshotSettings(input({ previewUrl: '' })).errors[0]).toMatch(/preview URL/);
        expect(validateScreenshotSettings(input({ previewUrl: 'localhost:3000' })).errors[0]).toMatch(/http:\/\//);
        expect(validateScreenshotSettings(input({ previewUrl: 'file:///tmp/a.html' })).errors[0]).toMatch(/http:\/\//);
    });

    it('refuses no pages and a page without a slash', () => {
        expect(validateScreenshotSettings(input({ pages: '' })).errors).toEqual(['Type at least one page path, for example /.']);
        expect(validateScreenshotSettings(input({ pages: 'settings' })).errors).toEqual(['The page path "settings" must start with "/".']);
    });

    it('refuses too many pages, a long wait, and a wrong width', () => {
        const many = Array.from({ length: 21 }, (_, index) => `/p${index}`).join('\n');
        expect(validateScreenshotSettings(input({ pages: many })).errors).toEqual(['Type at most 20 pages.']);
        expect(validateScreenshotSettings(input({ wait: '60001' })).errors).toEqual(['The wait must be at most 60000 ms.']);
        expect(validateScreenshotSettings(input({ viewportWidth: '100' })).errors[0]).toMatch(/320 to 3840/);
        expect(validateScreenshotSettings(input({ viewportWidth: 'wide' })).errors[0]).toMatch(/320 to 3840/);
    });

    it('gives the form values back from the settings', () => {
        const settings = validateScreenshotSettings(input({ wait: '500', viewportWidth: '390' })).settings;
        expect(screenshotSettingsInput(settings)).toEqual(input({ wait: '500', viewportWidth: '390' }));
        expect(screenshotSettingsInput(undefined)).toEqual({ previewUrl: '', pages: '', wait: '', viewportWidth: '' });
    });
});

describe('normalizeScreenshotSettings', () => {
    it('keeps valid stored settings', () => {
        expect(normalizeScreenshotSettings({ previewUrl: 'http://localhost:5173', pages: ['/'], viewportWidth: 800 })).toEqual({
            previewUrl: 'http://localhost:5173',
            pages: ['/'],
            viewportWidth: 800
        });
    });

    it('drops stored settings that are not valid', () => {
        expect(normalizeScreenshotSettings(undefined)).toBeUndefined();
        expect(normalizeScreenshotSettings({ previewUrl: 'ftp://x', pages: ['/'] })).toBeUndefined();
        expect(normalizeScreenshotSettings({ previewUrl: 'http://x', pages: [] })).toBeUndefined();
    });
});

describe('screenshot helpers', () => {
    it('reads the wait', () => {
        expect(parseWait('')).toEqual({ kind: 'none' });
        expect(parseWait(' 750 ')).toEqual({ kind: 'delay', ms: 750 });
        expect(parseWait('99999999')).toEqual({ kind: 'delay', ms: 60000 });
        expect(parseWait('[data-ready]')).toEqual({ kind: 'selector', selector: '[data-ready]' });
    });

    it('splits the pages', () => {
        expect(parsePages('/\r\n/a\n\n/a')).toEqual(['/', '/a']);
    });

    it('joins the preview URL and a page', () => {
        expect(pageUrl('http://localhost:3000/', '/a?b=1')).toBe('http://localhost:3000/a?b=1');
        expect(pageUrl('http://localhost:3000/app', 'x')).toBe('http://localhost:3000/app/x');
    });

    it('makes file names from page paths', () => {
        expect(pageSlug('/')).toBe('home');
        expect(pageSlug('/Users/42?tab=Info')).toBe('users-42-tab-info');
        expect(uploadFileName('base', '/settings', 1)).toBe('02-base-settings.png');
    });
});

describe('screenshotCommentMarkdown', () => {
    const shot = (branch: string, sha: string) => ({ branch, sha, capturedAt: 1 });
    const set: ScreenshotSet = {
        viewportWidth: 1280,
        pages: [
            { path: '/', base: shot('main', 'aaaaaaa111'), branch: shot('feature', 'bbbbbbb222') },
            { path: '/a|b', branch: shot('feature', 'bbbbbbb222') },
            { path: '/broken', branch: { ...shot('feature', 'bbbbbbb222'), error: 'ERR_CONNECTION_REFUSED' } }
        ]
    };

    it('builds a table of the base and the branch for each page', () => {
        const markdown = screenshotCommentMarkdown(set, [
            { page: '/', side: 'base', url: 'https://x/base.png' },
            { page: '/', side: 'branch', url: 'https://x/branch.png' },
            { page: '/a|b', side: 'branch', url: 'https://x/ab.png' }
        ]);
        expect(markdown).toBe(
            [
                '### Screenshots',
                '',
                'Base: `main` at aaaaaaa · Branch: `feature` at bbbbbbb · Width: 1280 px',
                '',
                '#### `/`',
                '',
                '| Base | Branch |',
                '| --- | --- |',
                '| ![Base /](https://x/base.png) | ![Branch /](https://x/branch.png) |',
                '',
                '#### `/a\\|b`',
                '',
                '| Base | Branch |',
                '| --- | --- |',
                '| _No image_ | ![Branch /a\\|b](https://x/ab.png) |',
                '',
                '<sub>Captured with ShipWarden.</sub>'
            ].join('\n')
        );
    });
});
