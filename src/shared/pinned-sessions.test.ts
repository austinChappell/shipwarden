import { describe, expect, it } from 'vitest';
import type { ChatItem } from './agent-chat';
import {
    claudeProjectFolder,
    cleanSessionName,
    normalizePinnedSession,
    pinOfTranscript,
    resumeCommand,
    sessionIdOf,
    sessionNamePrompt,
    sortPins,
    type PinnedSession
} from './pinned-sessions';

const ID = '1c9b47cc-a11d-4e49-a0f7-78590b290474';

function pin(overrides: Partial<PinnedSession> = {}): PinnedSession {
    return { id: 'p1', sessionId: ID, transcript: `/h/.claude/projects/-w/${ID}.jsonl`, name: 'Fix login', cwd: '/w', pinnedAt: 100, ...overrides };
}

describe('sessionIdOf', () => {
    it('reads the session ID from the transcript name', () => {
        expect(sessionIdOf(`/h/.claude/projects/-w/${ID}.jsonl`)).toBe(ID);
    });

    it('refuses a file that is not a session transcript', () => {
        expect(sessionIdOf('/h/notes.txt')).toBeUndefined();
        expect(sessionIdOf('/h/a b;rm.jsonl')).toBeUndefined();
    });
});

describe('claudeProjectFolder', () => {
    it('changes each character that is not a letter or a digit to "-"', () => {
        expect(claudeProjectFolder('/Users/me/.shipwarden/worktrees/app/fix-login')).toBe('-Users-me--shipwarden-worktrees-app-fix-login');
    });

    it('gives no name for a very long path, because Claude Code adds a hash', () => {
        expect(claudeProjectFolder(`/${'a'.repeat(250)}`)).toBeUndefined();
    });
});

describe('resumeCommand', () => {
    it('adds the session ID and the quoted name to the agent command', () => {
        expect(resumeCommand('claude --permission-mode plan', ID, "Fix Bob's login")).toBe(
            `claude --permission-mode plan --resume ${ID} --name 'Fix Bob'\\''s login'`
        );
        expect(resumeCommand(' claude ', ID)).toBe(`claude --resume ${ID}`);
    });

    it('refuses a session ID that is not safe in a shell', () => {
        expect(() => resumeCommand('claude', 'abc; rm -rf ~')).toThrow(/not valid/);
    });
});

describe('cleanSessionName', () => {
    it('keeps one line without quotes, Markdown, or a label', () => {
        expect(cleanSessionName('\n**Name:** "Fix flaky login test."\nMore text')).toBe('Fix flaky login test');
        expect(cleanSessionName('# Plan the billing migration')).toBe('Plan the billing migration');
    });

    it('cuts a long name', () => {
        expect(cleanSessionName('word '.repeat(40)).length).toBeLessThanOrEqual(60);
    });
});

describe('sessionNamePrompt', () => {
    it('has the prompts and the answers, without tool calls', () => {
        const items: ChatItem[] = [
            { kind: 'user', id: '1', text: 'Fix the login test' },
            { kind: 'tool', id: '2', name: 'Bash', summary: 'Running npm test', status: 'ok' },
            { kind: 'agent', id: '3', text: 'The test waits for a timer.' }
        ];
        const prompt = sessionNamePrompt(items);
        expect(prompt).toContain('User: Fix the login test');
        expect(prompt).toContain('Agent: The test waits for a timer.');
        expect(prompt).not.toContain('npm test');
    });

    it('keeps the first prompt and the newest messages of a long session', () => {
        const items: ChatItem[] = Array.from({ length: 40 }, (_, index) => ({
            kind: 'user' as const,
            id: String(index),
            text: `${index} ${'x'.repeat(1400)}`
        }));
        const prompt = sessionNamePrompt(items);
        expect(prompt).toContain('User: 0 ');
        expect(prompt).toContain('User: 39 ');
        expect(prompt).toMatch(/\[\d+ earlier messages are not shown\]/);
        expect(prompt.length).toBeLessThan(16_000);
    });
});

describe('normalizePinnedSession', () => {
    it('keeps a valid pin and drops the empty fields', () => {
        expect(normalizePinnedSession({ ...pin(), naming: false, repoPath: '' })).toEqual(pin());
    });

    it('refuses a pin without a transcript, a folder, or a time', () => {
        expect(normalizePinnedSession({ ...pin(), transcript: '' })).toBeUndefined();
        expect(normalizePinnedSession({ ...pin(), cwd: undefined })).toBeUndefined();
        expect(normalizePinnedSession({ ...pin(), pinnedAt: 0 })).toBeUndefined();
    });
});

describe('sortPins and pinOfTranscript', () => {
    it('puts the newest pin or resume first', () => {
        const a = pin({ id: 'a', pinnedAt: 100, resumedAt: 500 });
        const b = pin({ id: 'b', pinnedAt: 300 });
        expect(sortPins([b, a]).map(item => item.id)).toEqual(['a', 'b']);
    });

    it('finds the pin of a transcript in another folder by the session ID', () => {
        expect(pinOfTranscript([pin()], `/h/.claude/projects/-other/${ID}.jsonl`)?.id).toBe('p1');
        expect(pinOfTranscript([pin()], undefined)).toBeUndefined();
    });
});
