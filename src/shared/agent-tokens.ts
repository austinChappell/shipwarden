import { formatTokens, type TokenCount } from './automations';

/** The tokens of one agent session: all the session, and the part since the start of the local day. */
export interface AgentTokens {
    total: TokenCount;
    today: TokenCount;
}

/** Adds the counts. The result is a new object. */
export function addTokenCounts(counts: readonly TokenCount[]): TokenCount {
    const sum: TokenCount = { tokens: 0, cacheReads: 0 };
    for (const count of counts) {
        sum.tokens += count.tokens;
        sum.cacheReads += count.cacheReads;
    }
    return sum;
}

/**
 * Adds the tokens of the sessions. A transcript counts one time, also when two sessions have the same transcript.
 * A session without a transcript or without a count adds nothing.
 */
export function sumAgentTokens(transcripts: readonly (string | undefined)[], counts: Readonly<Record<string, AgentTokens>>): AgentTokens {
    const unique = [...new Set(transcripts.filter((file): file is string => !!file))];
    const found = unique.map(file => counts[file]).filter((item): item is AgentTokens => !!item);
    return { total: addTokenCounts(found.map(item => item.total)), today: addTokenCounts(found.map(item => item.today)) };
}

/** Returns the short text of a count, for example "48k tokens". */
export function tokensText(count: TokenCount): string {
    return `${formatTokens(count.tokens)} ${count.tokens === 1 ? 'token' : 'tokens'}`;
}

/** Returns the tooltip of a count. It tells what counts. */
export function tokensTitle(count: TokenCount): string {
    const reads = count.cacheReads > 0 ? ` The ${formatTokens(count.cacheReads)} cache reads do not count.` : ' Cache reads do not count.';
    return `${count.tokens.toLocaleString('en-US')} tokens: input, output, and cache writes.${reads}`;
}
