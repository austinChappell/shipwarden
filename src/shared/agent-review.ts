import type { DiffSide, PendingComment, RepoRef } from './github';
import { hunkLines } from './pr-search';
import { DEFAULT_REVIEW_STRICTNESS, strictnessInstructions, type ReviewStrictness } from './review-strictness';

/** The most diff text that a review prompt contains, for all files together. */
export const MAX_REVIEW_PATCH = 200_000;

export interface ReviewPromptInput {
    pr: { number: number; title: string; body?: string; url: string; baseRefName: string; headRefName: string; baseRefOid: string; headRefOid: string };
    repo: RepoRef;
    files: { path: string; previousPath?: string; status: string; patch?: string }[];
    /** How many comments the agent writes. Without it, "balanced". */
    strictness?: ReviewStrictness;
}

/** The lines of a file diff that can have a review comment: the lines in its "@@" hunks, by side. */
export interface CommentableLines {
    LEFT: Set<number>;
    RIGHT: Set<number>;
}

/**
 * Returns the lines that can have a review comment. GitHub accepts a comment only on a line in a hunk:
 * a removed line or a context line on the left (old) side, an added line or a context line on the right (new) side.
 */
export function commentableLines(patch: string | undefined): CommentableLines {
    const texts = lineTexts(patch);
    return { LEFT: new Set(texts.LEFT.keys()), RIGHT: new Set(texts.RIGHT.keys()) };
}

/** The text of each line of a file diff that can have a review comment, by side and line number. */
export interface LineTexts {
    LEFT: Map<number, string>;
    RIGHT: Map<number, string>;
}

/** Returns the text of each line in the "@@" hunks of a patch, by side and line number. */
export function lineTexts(patch: string | undefined): LineTexts {
    const result: LineTexts = { LEFT: new Map(), RIGHT: new Map() };
    for (const line of hunkLines(patch)) {
        if (line.left !== undefined) result.LEFT.set(line.left, line.text);
        if (line.right !== undefined) result.RIGHT.set(line.right, line.text);
    }
    return result;
}

/**
 * Returns true when a comment of an agent review still applies to the changed files of the pull request.
 * The comment applies when its line is in a hunk of its file and has the same text as before.
 * A file without a diff (binary or too large) keeps its comments, because the check cannot read its lines.
 * A comment that an agent review did not write always applies.
 */
export function agentCommentApplies(comment: PendingComment, files: readonly { path: string; patch?: string }[]): boolean {
    if (!comment.fromReview) return true;
    const file = files.find(item => item.path === comment.path);
    if (!file) return false;
    if (!file.patch) return true;
    const text = lineTexts(file.patch)[comment.side].get(comment.line);
    return text !== undefined && (comment.lineText === undefined || text === comment.lineText);
}

/**
 * Removes the texts of agent reviews from a review text. A text that the user changed is not found, so it stays.
 * The text before and after a removed text gets one blank line between them.
 */
export function withoutAgentTexts(body: string, texts: readonly string[]): string {
    let result = body;
    for (const text of texts) {
        const at = text ? result.indexOf(text) : -1;
        if (at < 0) continue;
        const before = result.slice(0, at).trimEnd();
        const after = result.slice(at + text.length).trimStart();
        result = [before, after].filter(Boolean).join('\n\n');
    }
    return result.trim();
}

/** The file diffs of a pull request for a prompt, from `fileDiffs`. */
export interface FileDiffs {
    /** One text for each file. Each text starts with a "---" line. */
    diffs: string[];
    /** The files without a diff in `diffs`, with the reason. */
    skipped: string[];
    /** The number of diff characters in `diffs`. */
    used: number;
}

/** Returns the diffs of the files for a prompt. A file diff that does not fit in `budget` characters goes to `skipped`. */
export function fileDiffs(files: ReviewPromptInput['files'], budget: number): FileDiffs {
    let left = budget;
    const diffs: string[] = [];
    const skipped: string[] = [];
    for (const file of files) {
        const name = file.previousPath && file.previousPath !== file.path ? `${file.previousPath} → ${file.path}` : file.path;
        if (!file.patch) {
            skipped.push(`${name} (${file.status}, no diff from GitHub: binary or too large)`);
            continue;
        }
        if (file.patch.length > left) {
            skipped.push(`${name} (${file.status}, the diff is too large for this prompt)`);
            continue;
        }
        left -= file.patch.length;
        diffs.push(`--- ${name} (${file.status})\n${file.patch}`);
    }
    return { diffs, skipped, used: budget - left };
}

/** Returns the prompt that asks an agent to review a pull request and to answer in JSON. */
export function reviewPrompt(input: ReviewPromptInput): string {
    const { pr, repo } = input;
    const { diffs, skipped } = fileDiffs(input.files, MAX_REVIEW_PATCH);
    const parts = [
        `Review pull request #${pr.number} "${pr.title}" in ${repo.owner}/${repo.name}: ${pr.url}`,
        `It merges ${pr.headRefName} (${pr.headRefOid}) into ${pr.baseRefName} (${pr.baseRefOid}).`
    ];
    if (pr.body?.trim()) {
        parts.push(`The description of the pull request:\n\n${pr.body.trim()}`);
    }
    parts.push(`The diff of each file. Each file starts with a "---" line:\n\n${diffs.join('\n\n') || '(no diff)'}`);
    if (skipped.length) {
        parts.push(`These files are not in the diff above:\n${skipped.map(item => `- ${item}`).join('\n')}`);
    }
    parts.push(
        [
            ...strictnessInstructions(input.strictness ?? DEFAULT_REVIEW_STRICTNESS),
            'Read more of the code if it helps you. Do not change files. Do not post comments on GitHub.',
            'Your answer must be one JSON object and nothing else, with this shape:',
            '{"summary": "<the review summary, in Markdown>", "comments": [{"path": "<file path>", "line": <line number>, "side": "RIGHT", "body": "<the comment, in Markdown>"}]}',
            '"side" is "RIGHT" for a line of the new version (an added line or a context line) and "LEFT" for a removed line.',
            '"line" is the line number in that version of the file. It must be a line in a "@@" hunk of the diff above.'
        ].join('\n')
    );
    return parts.join('\n\n');
}

export interface ParsedReview {
    summary: string;
    /** The comments on lines of the diff. Each one has `fromAgent`, `needsDecision`, `fromReview`, and `lineText`. */
    comments: PendingComment[];
    /** The comments that are not on a line of the diff, as Markdown list items. The caller adds them to the summary. */
    unplaced: string[];
}

/** Returns the JSON object in an answer. The object can be in a code fence or have text around it. */
export function extractJson(answer: string): unknown {
    const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(answer);
    const candidates = [answer.trim(), fenced?.[1], answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1)];
    for (const text of candidates) {
        if (!text) continue;
        try {
            return JSON.parse(text);
        } catch {
            // The next candidate can be valid JSON.
        }
    }
    return undefined;
}

/**
 * Reads the answer of a review agent. A comment on a line that is not in the diff of its file goes to `unplaced`,
 * because GitHub refuses it. When the answer is not JSON, all of it is the summary.
 */
export function parseAgentReview(answer: string, files: { path: string; patch?: string }[]): ParsedReview {
    const data = extractJson(answer);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { summary: answer.trim(), comments: [], unplaced: [] };
    }
    return readReview(data, files);
}

/**
 * Reads one review object of an agent: `{ summary, comments }`. A comment on a line that is not in the diff of its
 * file goes to `unplaced`.
 */
export function readReview(data: object, files: { path: string; patch?: string }[]): ParsedReview {
    const raw = data as { summary?: unknown; comments?: unknown };
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
    const lines = new Map(files.map(file => [file.path, lineTexts(file.patch)]));
    const comments: PendingComment[] = [];
    const unplaced: string[] = [];
    for (const item of Array.isArray(raw.comments) ? raw.comments : []) {
        if (!item || typeof item !== 'object') continue;
        const { path, line, side, body } = item as Record<string, unknown>;
        if (typeof body !== 'string' || !body.trim()) continue;
        const text = body.trim();
        const where = typeof path === 'string' ? `\`${path}\`${typeof line === 'number' ? ` line ${line}` : ''}` : 'General';
        const wanted: DiffSide = side === 'LEFT' ? 'LEFT' : 'RIGHT';
        const fileLines = typeof path === 'string' ? lines.get(path) : undefined;
        const lineText = Number.isInteger(line) ? fileLines?.[wanted].get(line as number) : undefined;
        if (typeof path === 'string' && lineText !== undefined) {
            comments.push({ path, line: line as number, side: wanted, body: text, fromAgent: true, needsDecision: true, fromReview: true, lineText });
        } else {
            unplaced.push(`- ${where}: ${text.replace(/\n/g, '\n  ')}`);
        }
    }
    return { summary, comments, unplaced };
}

/** Returns the review body: the summary, then the comments that are not on a line of the diff. */
export function reviewBody(review: ParsedReview): string {
    const parts = [review.summary];
    if (review.unplaced.length) {
        parts.push(`Other notes:\n\n${review.unplaced.join('\n')}`);
    }
    return parts.filter(Boolean).join('\n\n');
}
