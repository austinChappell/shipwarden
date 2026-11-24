import { describe, expect, it } from 'vitest';
import {
    DEFAULT_REMOTE_PORT,
    inputWrites,
    keyBytes,
    normalizeRemoteSettings,
    openTaskChoices,
    pairingLink,
    parsePairingLink,
    parseStartRequest,
    promptBranchName
} from './remote';
import type { Task } from './tasks';

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

describe('parseStartRequest', () => {
    it('accepts a prompt or a task, and cleans the branch', () => {
        expect(parseStartRequest({ repoPath: '/repo', prompt: '  Fix the login page ', branch: 'fix login', model: 'opus', agentId: 'claude' })).toEqual({
            repoPath: '/repo',
            prompt: 'Fix the login page',
            branch: 'fix-login',
            model: 'opus',
            agentId: 'claude'
        });
        expect(parseStartRequest({ repoPath: '/repo', task: { connectionId: 'c1', id: '7' }, prompt: '' })).toEqual({
            repoPath: '/repo',
            task: { connectionId: 'c1', id: '7' }
        });
    });

    it('refuses a request without a repository, without work, or with a task and a prompt', () => {
        expect(() => parseStartRequest(undefined)).toThrow('Select a repository.');
        expect(() => parseStartRequest({ repoPath: '/repo' })).toThrow('Select a task or type a prompt.');
        expect(() => parseStartRequest({ repoPath: '/repo', prompt: 'x', task: { connectionId: 'c', id: '1' } })).toThrow('not both');
        expect(() => parseStartRequest({ repoPath: '/repo', task: { id: '1' } })).toThrow('connection and an ID');
        expect(() => parseStartRequest({ repoPath: 42, prompt: 'x' })).toThrow('must be text');
    });

    it('refuses a model with spaces, a branch that git does not accept, and a long prompt', () => {
        expect(() => parseStartRequest({ repoPath: '/repo', prompt: 'x', model: 'opus; rm -rf' })).toThrow('one word');
        expect(() => parseStartRequest({ repoPath: '/repo', prompt: 'x', branch: '...' })).toThrow('not a valid branch name');
        expect(() => parseStartRequest({ repoPath: '/repo', prompt: 'x'.repeat(16_001) })).toThrow('too long');
    });
});

describe('promptBranchName', () => {
    it('uses the first words of the prompt', () => {
        expect(promptBranchName('Fix the login page on Safari, and add a test for it')).toBe('fix-the-login-page-on-safari');
    });

    it('uses the time when the prompt has no letters or digits', () => {
        expect(promptBranchName('!!! ???', Date.UTC(2026, 10, 23, 9, 5))).toBe('phone-202611230905');
    });
});

describe('openTaskChoices', () => {
    const task = (id: string, category: Task['status']['category']): Task => ({ id, title: `Task ${id}`, status: { id: category, name: category, category } });

    it('lists the open tasks without a worktree', () => {
        const links = { '/wt/a': { connectionId: 'c1', pluginId: 'p', taskId: '2', title: 'Task 2' } };
        const choices = openTaskChoices(
            'c1',
            [task('1', 'todo'), task('2', 'todo'), task('3', 'done'), task('4', 'canceled'), task('5', 'in_progress')],
            links
        );
        expect(choices).toEqual([
            { connectionId: 'c1', id: '1', title: 'Task 1', status: 'todo' },
            { connectionId: 'c1', id: '5', title: 'Task 5', status: 'in_progress' }
        ]);
    });
});
