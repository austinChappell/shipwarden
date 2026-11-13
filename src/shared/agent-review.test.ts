import { describe, expect, it } from 'vitest';
import { commentableLines, parseAgentReview, reviewBody, reviewPrompt } from './agent-review';
import { undecidedCount } from './github';

const PATCH = ['@@ -1,3 +1,3 @@', ' a', '-b', '+c', ' d'].join('\n');
const FILES = [{ path: 'src/x.ts', status: 'modified', patch: PATCH }];

describe('commentableLines', () => {
    it('has the hunk lines of each side', () => {
        const lines = commentableLines(PATCH);
        expect([...lines.LEFT]).toEqual([1, 2, 3]);
        expect([...lines.RIGHT]).toEqual([1, 2, 3]);
    });
});

describe('parseAgentReview', () => {
    it('keeps comments on diff lines and moves the others to the notes', () => {
        const answer = JSON.stringify({
            summary: 'Looks fine.',
            comments: [
                { path: 'src/x.ts', line: 2, side: 'RIGHT', body: 'Rename c.' },
                { path: 'src/x.ts', line: 40, side: 'RIGHT', body: 'Far away.' },
                { path: 'src/x.ts', line: 2, side: 'LEFT', body: 'Why remove b?' },
                { path: 'src/x.ts', line: 3, body: '' }
            ]
        });
        const review = parseAgentReview(answer, FILES);
        expect(review.summary).toBe('Looks fine.');
        expect(review.comments).toEqual([
            { path: 'src/x.ts', line: 2, side: 'RIGHT', body: 'Rename c.', fromAgent: true, needsDecision: true },
            { path: 'src/x.ts', line: 2, side: 'LEFT', body: 'Why remove b?', fromAgent: true, needsDecision: true }
        ]);
        expect(review.unplaced).toEqual(['- `src/x.ts` line 40: Far away.']);
        expect(reviewBody(review)).toBe('Looks fine.\n\nOther notes:\n\n- `src/x.ts` line 40: Far away.');
    });

    it('reads JSON in a code fence with text around it', () => {
        const answer = 'Here is the review:\n```json\n{"summary": "S", "comments": []}\n```\nDone.';
        expect(parseAgentReview(answer, FILES).summary).toBe('S');
    });

    it('uses the full answer as the summary when it is not JSON', () => {
        expect(parseAgentReview('No problems found.', FILES)).toEqual({ summary: 'No problems found.', comments: [], unplaced: [] });
    });
});

describe('reviewPrompt', () => {
    const pr = {
        number: 7,
        title: 'T',
        body: 'Body',
        url: 'https://github.com/o/r/pull/7',
        baseRefName: 'main',
        headRefName: 'f',
        baseRefOid: 'b'.repeat(40),
        headRefOid: 'h'.repeat(40)
    };

    it('has the diff, the files without a patch and the answer format', () => {
        const prompt = reviewPrompt({ pr, repo: { owner: 'o', name: 'r' }, files: [...FILES, { path: 'img.png', status: 'added' }] });
        expect(prompt).toContain('--- src/x.ts (modified)\n' + PATCH);
        expect(prompt).toContain('- img.png (added, no diff from GitHub: binary or too large)');
        expect(prompt).toContain('"comments"');
        expect(prompt).toContain('Body');
    });

    it('has the instructions of the strictness level', () => {
        const repo = { owner: 'o', name: 'r' };
        expect(reviewPrompt({ pr, repo, files: FILES })).toContain('Write only the review comments that are important.');
        expect(reviewPrompt({ pr, repo, files: FILES, strictness: 'relaxed' })).toContain('Find only bugs and security problems');
    });
});

describe('undecidedCount', () => {
    it('counts only the agent comments that the user did not accept', () => {
        const base = { path: 'src/x.ts', line: 2, side: 'RIGHT' as const, body: 'B' };
        expect(undecidedCount([{ ...base, fromAgent: true, needsDecision: true }, { ...base, fromAgent: true }, base])).toBe(1);
    });
});
