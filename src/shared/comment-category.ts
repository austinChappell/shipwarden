/**
 * The category of a review comment. It tells the author of the pull request how important the comment is.
 * The category goes into the comment text as a bold prefix, for example "**Must fix:** The loop never ends.".
 * GitHub shows the prefix as bold text. ShipWarden shows it as a colored chip.
 */
export type CommentCategory = 'must-fix' | 'concern' | 'pattern' | 'nit' | 'question';

export const COMMENT_CATEGORIES: readonly CommentCategory[] = ['must-fix', 'concern', 'pattern', 'nit', 'question'];

/** The prefix text and the description of each category, for the UI and for the review prompt. */
export const COMMENT_CATEGORY_TEXT: Record<CommentCategory, { label: string; description: string }> = {
    'must-fix': { label: 'Must fix', description: 'A bug, a security problem, or a break. The pull request must not merge with it.' },
    concern: { label: 'Concern', description: 'A risk or a doubt that the author must think about. It does not always need a change.' },
    pattern: { label: 'Pattern', description: 'The code does not follow a pattern or a convention of the repository.' },
    nit: { label: 'Nit', description: 'A small matter, for example a name or the style. The author can ignore it.' },
    question: { label: 'Question', description: 'The reviewer wants to know more. It is not a request for a change.' }
};

export function isCommentCategory(value: unknown): value is CommentCategory {
    return typeof value === 'string' && (COMMENT_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Finds a category prefix at the start of a comment: "**Must fix:**", "**Must fix**:", or "Must fix:".
 * The match ignores case. "Must-fix" also matches.
 */
const PREFIX = /^[ \t]*(\*\*|__)?(must[ -]fix|concern|pattern|nit|question)(?::\1|\1:)(?=\s|$)[ \t]*\n?/i;

export interface CategorizedText {
    category?: CommentCategory;
    /** The text after the prefix. When the text has no prefix, all of the text. */
    text: string;
}

/** Splits a comment into its category and the text after the category prefix. */
export function splitCategory(body: string): CategorizedText {
    const match = PREFIX.exec(body);
    if (!match) return { text: body };
    const category = match[2].toLowerCase().replace(' ', '-') as CommentCategory;
    return { category, text: body.slice(match[0].length) };
}

/**
 * Returns the comment text with the category prefix. A prefix in the text changes to the new category.
 * Without a category, the text does not change.
 */
export function withCategory(text: string, category: CommentCategory | undefined): string {
    if (!category) return text.trim();
    const rest = splitCategory(text).text.trim();
    const prefix = `**${COMMENT_CATEGORY_TEXT[category].label}:**`;
    return rest ? `${prefix} ${rest}` : prefix;
}

/** The lines of a review prompt that tell the agent how to set the category of each comment. */
export function categoryInstructions(): string {
    const items = COMMENT_CATEGORIES.map(category => `- "${category}": ${COMMENT_CATEGORY_TEXT[category].description}`);
    return ['Give each comment a "category". Use one of these values:', ...items].join('\n');
}
