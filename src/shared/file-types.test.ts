import { describe, expect, it } from 'vitest';
import { extensionOf, formatSize, isMediaKind, kindFromExtension, mimeTypeOf, sniffKind, sniffMimeType } from './file-types';

const bytes = (...values: (number | string)[]) =>
    new Uint8Array(values.flatMap(value => (typeof value === 'string' ? [...value].map(character => character.charCodeAt(0)) : [value])));

describe('extensionOf', () => {
    it('returns the extension in lower case', () => {
        expect(extensionOf('docs/Logo.PNG')).toBe('png');
        expect(extensionOf('archive.tar.gz')).toBe('gz');
    });

    it('returns an empty string for a name with no extension or a dot file', () => {
        expect(extensionOf('Makefile')).toBe('');
        expect(extensionOf('.gitignore')).toBe('');
        expect(extensionOf('folder.d/file')).toBe('');
    });
});

describe('kindFromExtension', () => {
    it('knows the image types', () => {
        for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.svg', 'a.bmp', 'a.ico', 'a.avif']) {
            expect(kindFromExtension(name)).toBe('image');
        }
    });

    it('knows PDF, audio, video and Markdown', () => {
        expect(kindFromExtension('spec.pdf')).toBe('pdf');
        expect(kindFromExtension('sound.mp3')).toBe('audio');
        expect(kindFromExtension('clip.webm')).toBe('video');
        expect(kindFromExtension('README.md')).toBe('markdown');
        expect(kindFromExtension('notes.markdown')).toBe('markdown');
    });

    it('knows binary types and leaves other types to the first bytes', () => {
        expect(kindFromExtension('build.zip')).toBe('binary');
        expect(kindFromExtension('font.woff2')).toBe('binary');
        expect(kindFromExtension('index.ts')).toBeUndefined();
        expect(kindFromExtension('Dockerfile')).toBeUndefined();
    });
});

describe('mimeTypeOf', () => {
    it('returns the type of viewable files only', () => {
        expect(mimeTypeOf('a.svg')).toBe('image/svg+xml');
        expect(mimeTypeOf('a.JPG')).toBe('image/jpeg');
        expect(mimeTypeOf('a.pdf')).toBe('application/pdf');
        expect(mimeTypeOf('a.ts')).toBeUndefined();
    });
});

describe('sniffKind', () => {
    it('finds images and PDF from their signatures', () => {
        expect(sniffKind(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image');
        expect(sniffKind(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image');
        expect(sniffKind(bytes('GIF89a', 0))).toBe('image');
        expect(sniffKind(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe('image');
        expect(sniffKind(bytes('%PDF-1.7\n'))).toBe('pdf');
    });

    it('finds binary files from a NUL byte', () => {
        expect(sniffKind(bytes('abc', 0, 'def'))).toBe('binary');
    });

    it('returns text for text and an empty file', () => {
        expect(sniffKind(bytes('#!/bin/sh\necho hi\n'))).toBe('text');
        expect(sniffKind(new Uint8Array())).toBe('text');
    });

    it('does not take "RIFF" alone as an image', () => {
        expect(sniffKind(bytes('RIFF', 0, 0, 0, 0, 'WAVE'))).toBe('binary');
    });
});

describe('sniffMimeType', () => {
    it('returns the type from the signature', () => {
        expect(sniffMimeType(bytes(0x89, 'PNG'))).toBe('image/png');
        expect(sniffMimeType(bytes('%PDF-'))).toBe('application/pdf');
        expect(sniffMimeType(bytes('hello'))).toBeUndefined();
    });
});

describe('isMediaKind', () => {
    it('is true only for the kinds of the file protocol', () => {
        expect(['image', 'pdf', 'audio', 'video'].every(kind => isMediaKind(kind as never))).toBe(true);
        expect(['text', 'markdown', 'binary'].some(kind => isMediaKind(kind as never))).toBe(false);
    });
});

describe('formatSize', () => {
    it('formats bytes for people', () => {
        expect(formatSize(512)).toBe('512 B');
        expect(formatSize(1536)).toBe('1.5 KB');
        expect(formatSize(20 * 1024)).toBe('20 KB');
        expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
        expect(formatSize(3 * 1024 ** 3)).toBe('3.0 GB');
    });
});
