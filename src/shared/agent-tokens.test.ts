import { describe, expect, it } from 'vitest';
import { addTokenCounts, sumAgentTokens, tokensText, tokensTitle, type AgentTokens } from './agent-tokens';

const tokens = (total: number, today: number, reads = 0): AgentTokens => ({
    total: { tokens: total, cacheReads: reads },
    today: { tokens: today, cacheReads: 0 }
});

describe('addTokenCounts', () => {
    it('adds the tokens and the cache reads', () => {
        expect(
            addTokenCounts([
                { tokens: 100, cacheReads: 5 },
                { tokens: 50, cacheReads: 0 }
            ])
        ).toEqual({ tokens: 150, cacheReads: 5 });
    });

    it('gives zero for no counts', () => {
        expect(addTokenCounts([])).toEqual({ tokens: 0, cacheReads: 0 });
    });
});

describe('sumAgentTokens', () => {
    const counts = { '/a.jsonl': tokens(1000, 200, 30), '/b.jsonl': tokens(500, 500) };

    it('adds the total and the part of today of each transcript', () => {
        expect(sumAgentTokens(['/a.jsonl', '/b.jsonl'], counts)).toEqual({
            total: { tokens: 1500, cacheReads: 30 },
            today: { tokens: 700, cacheReads: 0 }
        });
    });

    it('counts a transcript one time', () => {
        expect(sumAgentTokens(['/a.jsonl', '/a.jsonl'], counts).total.tokens).toBe(1000);
    });

    it('ignores a session without a transcript or without a count', () => {
        expect(sumAgentTokens([undefined, '/c.jsonl', '/b.jsonl'], counts).total.tokens).toBe(500);
    });
});

describe('tokensText', () => {
    it('gives a short number and the noun', () => {
        expect(tokensText({ tokens: 1, cacheReads: 0 })).toBe('1 token');
        expect(tokensText({ tokens: 950, cacheReads: 0 })).toBe('950 tokens');
        expect(tokensText({ tokens: 48_210, cacheReads: 0 })).toBe('48k tokens');
        expect(tokensText({ tokens: 1_250_000, cacheReads: 0 })).toBe('1.3M tokens');
    });
});

describe('tokensTitle', () => {
    it('tells what counts and gives the cache reads', () => {
        expect(tokensTitle({ tokens: 48_210, cacheReads: 2_000_000 })).toBe('48,210 tokens: input, output, and cache writes. The 2M cache reads do not count.');
        expect(tokensTitle({ tokens: 10, cacheReads: 0 })).toBe('10 tokens: input, output, and cache writes. Cache reads do not count.');
    });
});
