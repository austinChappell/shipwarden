import { describe, expect, it } from 'vitest';
import { recentSessionOf, summarizeTranscriptLines, visibleRecentSessions, type RecentSession } from './recent-sessions';

const line = (value: unknown) => JSON.stringify(value);
const FILE = { transcript: '/c/projects/-w-app/abc12345.jsonl', sessionId: 'abc12345', updatedAt: 1000 };

describe('summarizeTranscriptLines', () => {
    it('reads the folder, the branch, the entry point, and the first typed prompt', () => {
        const summary = summarizeTranscriptLines({}, [
            line({ type: 'mode', mode: 'normal' }),
            line({ type: 'user', isMeta: true, message: { content: 'Caveat: ignore this' }, cwd: '/w/app', gitBranch: 'main', entrypoint: 'cli' }),
            line({ type: 'user', message: { content: '<command-name>/clear</command-name>' }, cwd: '/w/app' }),
            line({ type: 'user', message: { content: [{ type: 'text', text: 'Fix the login test' }] }, cwd: '/w/app', gitBranch: 'fix' }),
            line({ type: 'user', message: { content: 'A second prompt' } }),
            'not json'
        ]);
        expect(summary).toEqual({ cwd: '/w/app', branch: 'fix', entrypoint: 'cli', firstPrompt: 'Fix the login test' });
    });

    it('keeps the newest titles', () => {
        const summary = summarizeTranscriptLines({ aiTitle: 'Old' }, [
            line({ type: 'ai-title', aiTitle: 'New title' }),
            line({ type: 'custom-title', customTitle: 'My title' })
        ]);
        expect(summary).toMatchObject({ aiTitle: 'New title', customTitle: 'My title' });
    });
});

describe('recentSessionOf', () => {
    it('names the session from the custom title, the AI title, then the first prompt', () => {
        const base = { cwd: '/w/app', firstPrompt: 'fix the test', entrypoint: 'cli' };
        expect(recentSessionOf({ ...base, aiTitle: 'AI', customTitle: 'Custom' }, FILE)?.name).toBe('Custom');
        expect(recentSessionOf({ ...base, aiTitle: 'AI' }, FILE)?.name).toBe('AI');
        expect(recentSessionOf(base, FILE)).toEqual({ ...FILE, name: 'fix the test', cwd: '/w/app' });
    });

    it('leaves out print mode runs, sessions without a prompt, and a detached HEAD branch', () => {
        expect(recentSessionOf({ cwd: '/w', firstPrompt: 'x', entrypoint: 'sdk-cli' }, FILE)).toBeUndefined();
        expect(recentSessionOf({ cwd: '/w', entrypoint: 'cli' }, FILE)).toBeUndefined();
        expect(recentSessionOf({ firstPrompt: 'x' }, FILE)).toBeUndefined();
        expect(recentSessionOf({ cwd: '/w', firstPrompt: 'x', branch: 'HEAD' }, FILE)?.branch).toBeUndefined();
    });
});

describe('visibleRecentSessions', () => {
    it('leaves out pinned sessions and running sessions', () => {
        const session = (sessionId: string): RecentSession => ({ ...FILE, sessionId, name: sessionId, cwd: '/w' });
        const list = [session('a'), session('b'), session('c')];
        expect(visibleRecentSessions(list, new Set(['a']), new Set(['c'])).map(item => item.sessionId)).toEqual(['b']);
    });
});
