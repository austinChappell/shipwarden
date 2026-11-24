import { describe, expect, it } from 'vitest';
import { helpText, parseArgs } from './args';

describe('parseArgs', () => {
    it('gives the help without words, and for help and --help', () => {
        expect(parseArgs([]).kind).toBe('help');
        expect(parseArgs(['help']).kind).toBe('help');
        expect(parseArgs(['worktree', 'list', '--help']).kind).toBe('help');
        expect(parseArgs(['-v']).kind).toBe('version');
    });

    it('parses a command with switches and --json', () => {
        expect(parseArgs(['worktree', 'list', '--all', '--json'])).toEqual({
            kind: 'request',
            command: 'worktree.list',
            args: { all: true },
            json: true,
            readStdin: false
        });
        expect(parseArgs(['status'])).toEqual({ kind: 'request', command: 'status', args: {}, json: false, readStdin: false });
    });

    it('parses the positional value and the value flags in any order', () => {
        expect(parseArgs(['worktree', 'create', '--repo', '/r/app', 'feature/login', '--prompt=Fix it', '--wait'])).toEqual({
            kind: 'request',
            command: 'worktree.create',
            args: { repo: '/r/app', branch: 'feature/login', prompt: 'Fix it', wait: true },
            json: false,
            readStdin: false
        });
    });

    it('joins the words of a prompt, and converts the timeout', () => {
        const parsed = parseArgs(['agent', 'send', 'Run', 'the', 'tests', '--worktree', 'main', '--timeout', '90']);
        expect(parsed).toMatchObject({ command: 'agent.send', args: { prompt: 'Run the tests', worktree: 'main', timeout: 90 } });
    });

    it('reads the prompt from stdin for "-"', () => {
        expect(parseArgs(['agent', 'send', '-'])).toMatchObject({ readStdin: true, args: { prompt: '-' } });
    });

    it('converts a kebab-case switch', () => {
        expect(parseArgs(['worktree', 'remove', 'old', '--delete-branch'])).toMatchObject({ args: { worktree: 'old', deleteBranch: true } });
    });

    it('gives an error for wrong input', () => {
        expect(parseArgs(['worktree', 'create'])).toEqual({ kind: 'error', message: expect.stringContaining('Usage') });
        expect(parseArgs(['nothing'])).toMatchObject({ kind: 'error' });
        expect(parseArgs(['status', '--all'])).toMatchObject({ kind: 'error', message: expect.stringContaining('Unknown option --all') });
        expect(parseArgs(['status', 'extra'])).toMatchObject({ kind: 'error' });
        expect(parseArgs(['agent', 'wait', '--timeout', 'soon'])).toMatchObject({ kind: 'error' });
        expect(parseArgs(['agent', 'wait', '--worktree'])).toMatchObject({ kind: 'error', message: 'Give a value after --worktree.' });
        expect(parseArgs(['agent', 'send', 'hi', '--wait=yes'])).toMatchObject({ kind: 'error' });
    });

    it('parses the skill commands', () => {
        expect(parseArgs(['skill'])).toEqual({ kind: 'skill', action: 'print', json: false });
        expect(parseArgs(['skill', 'install', '--dir', '/tmp/skills'])).toEqual({ kind: 'skill', action: 'install', dir: '/tmp/skills', json: false });
        expect(parseArgs(['skill', 'remove'])).toMatchObject({ kind: 'error' });
    });

    it('lists each command in the help', () => {
        const text = helpText();
        for (const words of ['worktree create', 'agent wait', 'task status', 'automation run', 'skill']) {
            expect(text).toContain(`shipwarden ${words}`);
        }
    });
});
