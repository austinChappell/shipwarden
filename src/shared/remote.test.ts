import { describe, expect, it } from 'vitest';
import { DEFAULT_REMOTE_PORT, inputWrites, keyBytes, normalizeRemoteSettings, pairingLink, parsePairingLink } from './remote';

const fingerprint = 'ab'.repeat(32);
const modes = { bracketedPaste: false, applicationCursorKeys: false };

describe('pairing links', () => {
    it('reads the link that it makes', () => {
        const link = { name: "Austin's Mac", hosts: ['mac.local', '192.168.1.4'], port: 7429, fingerprint, code: 'abc_-123' };
        expect(parsePairingLink(pairingLink(link))).toEqual(link);
    });

    it('refuses other links and links with missing parts', () => {
        expect(parsePairingLink('https://example.com')).toBeUndefined();
        expect(parsePairingLink('not a link')).toBeUndefined();
        expect(parsePairingLink(`shipwarden://pair?h=mac.local&p=7429&fp=${fingerprint}`)).toBeUndefined();
        expect(parsePairingLink(`shipwarden://pair?h=mac.local&p=7429&fp=1234&c=x`)).toBeUndefined();
        expect(parsePairingLink(`shipwarden://pair?h=&p=7429&fp=${fingerprint}&c=x`)).toBeUndefined();
        expect(parsePairingLink(`shipwarden://pair?h=mac.local&p=99999&fp=${fingerprint}&c=x`)).toBeUndefined();
    });
});

describe('normalizeRemoteSettings', () => {
    it('is off by default and keeps a valid port only', () => {
        expect(normalizeRemoteSettings(undefined)).toEqual({ enabled: false, port: DEFAULT_REMOTE_PORT, keepRunning: false });
        expect(normalizeRemoteSettings({ enabled: true, port: 8443 })).toEqual({ enabled: true, port: 8443, keepRunning: false });
        expect(normalizeRemoteSettings({ enabled: true, port: 8443, keepRunning: true })).toEqual({ enabled: true, port: 8443, keepRunning: true });
        expect(normalizeRemoteSettings({ enabled: 'yes', port: 80 })).toEqual({ enabled: false, port: DEFAULT_REMOTE_PORT, keepRunning: false });
    });
});

describe('input', () => {
    it('knows only the listed keys', () => {
        expect(keyBytes('enter')).toBe('\r');
        expect(keyBytes('shiftTab')).toBe('\x1b[Z');
        expect(keyBytes('rm -rf')).toBeUndefined();
        expect(keyBytes(42)).toBeUndefined();
    });

    it('sends the text and Enter in separate writes', () => {
        expect(inputWrites({ text: 'yes', submit: true }, modes)).toEqual(['yes', '\r']);
        expect(inputWrites({ key: 'escape' }, modes)).toEqual(['\x1b']);
        expect(inputWrites({}, modes)).toEqual([]);
    });

    it('sends text with new lines as a bracketed paste when the program accepts it', () => {
        expect(inputWrites({ text: 'a\nb', submit: true }, { ...modes, bracketedPaste: true })).toEqual(['\x1b[200~a\nb\x1b[201~', '\r']);
        expect(inputWrites({ text: 'a\nb' }, modes)).toEqual(['a\nb']);
        expect(inputWrites({ text: 'one line' }, { ...modes, bracketedPaste: true })).toEqual(['one line']);
    });

    it('sends the application form of the arrow keys in that mode', () => {
        expect(inputWrites({ key: 'up' }, { ...modes, applicationCursorKeys: true })).toEqual(['\x1bOA']);
        expect(inputWrites({ key: 'up' }, modes)).toEqual(['\x1b[A']);
    });
});
