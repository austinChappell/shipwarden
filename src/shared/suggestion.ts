import { locateCode } from './ask-agent';
import type { ReviewThread } from './github';

/**
 * Suggested changes in review comments, as on GitHub.
 * A "```suggestion" block in a comment holds the new text of the lines that the comment is on.
 */

/** One part of a comment body: Markdown text, or the new lines of a suggestion block. */
export type CommentPart = { kind: 'text'; text: string } | { kind: 'suggestion'; lines: string[] };

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Splits a comment body into Markdown text and suggestion blocks.
 * A suggestion block in a different code block is text. A suggestion block without a closing fence ends at the end of the body.
 */
export function splitSuggestions(body: string): CommentPart[] {
    const parts: CommentPart[] = [];
    let text: string[] = [];
    /** The open fence: its characters, its indent, and true when it is a suggestion block. */
    let fence: { marker: string; indent: number; suggestion: boolean } | undefined;
    let lines: string[] = [];
    const flushText = () => {
        if (text.length) parts.push({ kind: 'text', text: text.join('\n') });
        text = [];
    };
    for (const line of body.split(/\r?\n/)) {
        const match = FENCE.exec(line);
        if (!fence) {
            if (match && !(match[2][0] === '`' && match[3].includes('`'))) {
                const suggestion = match[3].trim().toLowerCase() === 'suggestion';
                fence = { marker: match[2], indent: match[1].length, suggestion };
                if (suggestion) {
                    flushText();
                    lines = [];
                    continue;
                }
            }
            text.push(line);
            continue;
        }
        const closes = !!match && match[2][0] === fence.marker[0] && match[2].length >= fence.marker.length && match[3].trim() === '';
        if (fence.suggestion) {
            if (closes) {
                parts.push({ kind: 'suggestion', lines });
                fence = undefined;
            } else {
                lines.push(removeIndent(line, fence.indent));
            }
            continue;
        }
        text.push(line);
        if (closes) fence = undefined;
    }
    if (fence?.suggestion) parts.push({ kind: 'suggestion', lines });
    flushText();
    return parts;
}

/** Removes up to `count` spaces from the start of a line, as CommonMark does for an indented fence. */
function removeIndent(line: string, count: number): string {
    let index = 0;
    while (index < count && line[index] === ' ') index++;
    return line.slice(index);
}

/** Returns true when the body has a suggestion block. */
export function hasSuggestion(body: string): boolean {
    return splitSuggestions(body).some(part => part.kind === 'suggestion');
}

/**
 * Makes a suggestion block with the lines of `code`. The fence is longer than each run of backticks in the code,
 * so a fence in the code does not close the block.
 */
export function suggestionBlock(code: string): string {
    const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map(match => match[0].length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}suggestion\n${code}\n${fence}`;
}

/**
 * Returns the last `count` lines of the new side of a diff hunk. GitHub ends the hunk of a comment at the last line
 * of the comment. Returns undefined when the hunk has fewer lines.
 */
export function hunkLines(diffHunk: string, count: number): string[] | undefined {
    const lines = diffHunk.split(/\r?\n/);
    const body = lines[0]?.startsWith('@@') ? lines.slice(1) : lines;
    const newSide = body.filter(line => line[0] === ' ' || line[0] === '+' || line === '').map(line => line.slice(1));
    // A hunk text can end with a newline. It is not a line of the file.
    if (newSide.length && body[body.length - 1] === '') newSide.pop();
    if (count < 1 || newSide.length < count) return undefined;
    return newSide.slice(newSide.length - count);
}

/** The lines that a suggestion replaces. */
export interface SuggestionTarget {
    /** The first line in the newest version of the file that GitHub knows. The search for the old lines starts here. */
    startLine: number;
    /** The last line. */
    line: number;
    /** The text of the lines when the reviewer wrote the comment. */
    original: string[];
}

/**
 * Returns the lines that a suggestion in a review thread replaces. The old text comes from the diff hunk of the first comment.
 * Returns undefined for a thread on the old side, or when the thread has no diff hunk.
 */
export function threadSuggestionTarget(thread: ReviewThread): SuggestionTarget | undefined {
    const hunk = thread.comments[0]?.diffHunk;
    const end = thread.originalLine ?? thread.line;
    if (thread.side !== 'RIGHT' || !hunk || !end) return undefined;
    const start = thread.originalStartLine ?? end;
    const original = hunkLines(hunk, end - start + 1);
    if (!original) return undefined;
    const line = thread.line ?? end;
    return { startLine: line - original.length + 1, line, original };
}

/**
 * The result of a suggestion on a file:
 * - "applied": `text` is the new content of the file. `startLine` and `line` are the replaced lines.
 * - "already": the file already has the new lines. Nothing changes.
 * - "stale": the old lines are not in the file. They changed after the comment.
 */
export type ApplyResult =
    | { kind: 'applied'; text: string; startLine: number; line: number }
    | { kind: 'already' }
    | { kind: 'stale' };

/**
 * Replaces the old lines of a suggestion with the new lines in the text of a file.
 * The function finds the old lines by their text, near `target.startLine`, so a line that moved is not a problem.
 * The line endings of the file and its last newline do not change.
 */
export function applySuggestion(text: string, target: SuggestionTarget, replacement: readonly string[]): ApplyResult {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    // The text after the last newline is an empty "line". It is not a line of the file.
    const finalNewline = lines.length > 1 && lines[lines.length - 1] === '';
    if (finalNewline) lines.pop();
    const same = target.original.length === replacement.length && target.original.every((value, index) => value === replacement[index]);
    if (same) return { kind: 'already' };
    const found = locateCode(lines, { startLine: target.startLine, line: target.line, code: target.original.join('\n') });
    if (!found) {
        // The new lines at the old place show that the user applied the suggestion before.
        const applied = replacement.length > 0 && replacement.every((value, index) => lines[target.startLine - 1 + index] === value);
        if (applied) return { kind: 'already' };
        return { kind: 'stale' };
    }
    const next = [...lines.slice(0, found.startLine - 1), ...replacement, ...lines.slice(found.line)];
    return { kind: 'applied', text: next.join(eol) + (finalNewline && next.length ? eol : ''), startLine: found.startLine, line: found.line };
}
