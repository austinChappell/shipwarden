/**
 * The strictness of an agent review: how many comments the agent writes. A low level gives fewer comments, so the
 * user does not get comments that only fill space. The settings have a global default and a default for each
 * repository. The user can select a different level for one run.
 */
export type ReviewStrictness = 'relaxed' | 'balanced' | 'strict';

export const REVIEW_STRICTNESS_LEVELS: readonly ReviewStrictness[] = ['relaxed', 'balanced', 'strict'];

export const DEFAULT_REVIEW_STRICTNESS: ReviewStrictness = 'balanced';

/** The name and the description of each level, for the UI. */
export const REVIEW_STRICTNESS_TEXT: Record<ReviewStrictness, { label: string; description: string }> = {
    relaxed: { label: 'Relaxed', description: 'Only bugs and security problems. No comments about style. Often no comments.' },
    balanced: { label: 'Balanced', description: 'Bugs, security problems, missing tests, and code that is hard to maintain.' },
    strict: { label: 'Strict', description: 'A full review. Also names, small risks, edge cases, and style.' }
};

export function isReviewStrictness(value: unknown): value is ReviewStrictness {
    return typeof value === 'string' && (REVIEW_STRICTNESS_LEVELS as readonly string[]).includes(value);
}

/**
 * Returns the instructions of a level for a review prompt: what to look for and when to write a comment.
 * `scope` is an extra sentence about what to look at most, for example the problems between the pull requests of a group.
 */
export function strictnessInstructions(level: ReviewStrictness, scope?: string): string[] {
    const extra = scope ? [scope] : [];
    switch (level) {
        case 'relaxed':
            return [
                'Find only bugs and security problems: code that gives a wrong result, crashes, loses data, or is not safe.',
                ...extra,
                'Do not write about style, names, formatting, small refactors, tests, or code that only could be better. Do not write a comment that only praises the code.',
                'Write a comment only when you are sure that the problem is real. When you find no real problem, write a short summary and no comments. An empty comment list is a good result.'
            ];
        case 'strict':
            return [
                'Find bugs, security problems, missing tests, edge cases, performance problems, unclear names, and code that is hard to maintain or does not follow the style of the repository.',
                ...extra,
                'Write a comment for each problem that you find, also for small problems. Do not write a comment that only praises the code.'
            ];
        default:
            return [
                'Find bugs, security problems, missing tests, and code that is hard to maintain.',
                ...extra,
                'Write only the review comments that are important. Do not write about small style matters. Do not write a comment that only praises the code.'
            ];
    }
}
