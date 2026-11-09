import type { DiffSide, PendingComment, RepoRef } from './github';
import { hunkLines } from './pr-search';

/** The most diff text that a review prompt contains, for all files together. */
export const MAX_REVIEW_PATCH = 200_000;

export interface ReviewPromptInput {
    pr: { number: number; title: string; body?: string; url: string; baseRefName: string; headRefName: string; baseRefOid: string; headRefOid: string };
    repo: RepoRef;
    files: { path: string; previousPath?: string; status: string; patch?: string }[];
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
    const result: CommentableLines = { LEFT: new Set(), RIGHT: new Set() };
    for (const line of hunkLines(patch)) {
        if (line.left !== undefined) result.LEFT.add(line.left);
        if (line.right !== undefined) result.RIGHT.add(line.right);
    }
    return result;
}

/** Returns the prompt that asks an agent to review a pull request and to answer in JSON. */
export function reviewPrompt(input: ReviewPromptInput): string {
    const { pr, repo } = input;
    let budget = MAX_REVIEW_PATCH;
    const diffs: string[] = [];
    const skipped: string[] = [];
    for (const file of input.files) {
        const name = file.previousPath && file.previousPath !== file.path ? `${file.previousPath} → ${file.path}` : file.path;
        if (!file.patch) {
            skipped.push(`${name} (${file.status}, no diff from GitHub: binary or too large)`);
            continue;
        }
        if (file.patch.length > budget) {
            skipped.push(`${name} (${file.status}, the diff is too large for this prompt)`);
            continue;
        }
        budget -= file.patch.length;
        diffs.push(`--- ${name} (${file.status})\n${file.patch}`);
    }
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
    parts.push([
        'Find bugs, security problems, missing tests and code that is hard to maintain. Read more of the code if it helps you. Do not change files. Do not post comments on GitHub.',
        'Write only the review comments that are important. Do not write a comment that only praises the code.',
        'Your answer must be one JSON object and nothing else, with this shape:',
        '{"summary": "<the review summary, in Markdown>", "comments": [{"path": "<file path>", "line": <line number>, "side": "RIGHT", "body": "<the comment, in Markdown>"}]}',
        '"side" is "RIGHT" for a line of the new version (an added line or a context line) and "LEFT" for a removed line.',
        '"line" is the line number in that version of the file. It must be a line in a "@@" hunk of the diff above.'
    ].join('\n'));
    return parts.join('\n\n');
}

export interface ParsedReview {
    summary: string;
    /** The comments on lines of the diff. Each one has `fromAgent`. */
    comments: PendingComment[];
    /** The comments that are not on a line of the diff, as Markdown list items. The caller adds them to the summary. */
    unplaced: string[];
}

/** Returns the JSON object in an answer. The object can be in a code fence or have text around it. */
function extractJson(answer: string): unknown {
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
    const raw = data as { summary?: unknown; comments?: unknown };
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
    const lines = new Map(files.map(file => [file.path, commentableLines(file.patch)]));
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
        if (typeof path === 'string' && Number.isInteger(line) && fileLines?.[wanted].has(line as number)) {
            comments.push({ path, line: line as number, side: wanted, body: text, fromAgent: true });
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
