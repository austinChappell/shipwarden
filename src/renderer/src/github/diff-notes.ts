import type { DiffLineAnnotation } from '@pierre/diffs/react';
import type { DiffSide, PendingComment, PullRequestFile, ReviewThread } from '@shared/github';
import type { AgentQuestion } from './agent-questions';

/** The box for a new comment or question: the lines from `startLine` to `line` on one side. */
export interface Composer {
    line: number;
    startLine: number;
    side: DiffSide;
}

/** What an annotation under a diff line shows: a review thread, a pending comment, or the box for a new comment. */
export type Note =
    | { kind: 'thread'; thread: ReviewThread }
    | { kind: 'pending'; comment: PendingComment }
    | { kind: 'composer'; line: number; startLine: number; side: DiffSide }
    | { kind: 'question'; question: AgentQuestion };

/** The side of a line in the diff component. */
export type DiffColumn = 'deletions' | 'additions';

export const toSide = (side: DiffSide): DiffColumn => (side === 'LEFT' ? 'deletions' : 'additions');
export const fromSide = (side: DiffColumn | undefined): DiffSide => (side === 'deletions' ? 'LEFT' : 'RIGHT');

/** The notes of one file that show under its lines. */
export interface FileNotes {
    path: string;
    threads: ReviewThread[];
    pending: PendingComment[];
    questions: AgentQuestion[];
    composer: Composer | undefined;
}

/**
 * Returns the annotations of one file: the threads, the pending comments, the questions and the comment box.
 * `pending` and `questions` must contain only the items of the file.
 */
export function lineAnnotations({ path, threads, pending, questions, composer }: FileNotes): DiffLineAnnotation<Note>[] {
    const list: DiffLineAnnotation<Note>[] = [];
    for (const thread of threads) {
        if (thread.path !== path) continue;
        // An outdated thread has no line in the current diff. It shows above the first line.
        list.push({ side: toSide(thread.side), lineNumber: thread.line ?? 0, metadata: { kind: 'thread', thread } });
    }
    for (const comment of pending) {
        list.push({ side: toSide(comment.side), lineNumber: comment.line, metadata: { kind: 'pending', comment } });
    }
    for (const question of questions) {
        list.push({ side: toSide(question.side), lineNumber: question.line, metadata: { kind: 'question', question } });
    }
    if (composer) {
        list.push({ side: toSide(composer.side), lineNumber: composer.line, metadata: { kind: 'composer', ...composer } });
    }
    return list;
}

/** A range of lines that the user selects with the "+" in the gutter. */
export interface GutterRange {
    start: number;
    end: number;
    side?: DiffColumn;
    endSide?: DiffColumn;
}

/** Returns the comment box for a gutter range. The comment goes on the last line. */
export function composerFromRange(range: GutterRange): Composer {
    const side = fromSide(range.endSide ?? range.side);
    // A range across both sides has no clear start line, so the box takes only the last line.
    const sameSide = fromSide(range.side) === side;
    return { line: range.end, startLine: sameSide ? Math.min(range.start, range.end) : range.end, side };
}

/** Returns the threads of a file that have a line in the current diff. The Monaco diff shows only these threads. */
export function threadsWithLine(threads: ReviewThread[], path: string): (ReviewThread & { line: number })[] {
    return threads.filter((thread): thread is ReviewThread & { line: number } => thread.path === path && thread.line !== null);
}

/** The part of an editor selection that sets the lines of a comment. The lines and the columns start at 1. */
export interface EditorSelection {
    startLineNumber: number;
    endLineNumber: number;
    endColumn: number;
    positionLineNumber: number;
    isEmpty(): boolean;
}

/**
 * Returns the selected lines of an editor, or the line of the cursor without a selection.
 * A selection that ends at column 1 does not contain its last line.
 */
export function selectionLines(selection: EditorSelection | null): { startLine: number; line: number } | undefined {
    if (!selection) return undefined;
    if (selection.isEmpty()) return { startLine: selection.positionLineNumber, line: selection.positionLineNumber };
    const end = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
    return { startLine: selection.startLineNumber, line: end };
}

/** True when a file of the stream is open. A file without an entry in `open` is open unless the user marked it as viewed. */
export function isFileOpen(open: Record<string, boolean>, file: PullRequestFile): boolean {
    return open[file.path] ?? !file.viewed;
}

/** Returns the open state of all files: all open or all closed. */
export function allFilesOpen(files: PullRequestFile[], value: boolean): Record<string, boolean> {
    return Object.fromEntries(files.map(file => [file.path, value]));
}

/** Returns the index of the current search match. An index after the end goes to the last match. */
export function currentMatchIndex(index: number, count: number): number {
    return Math.min(index, count - 1);
}

/** Returns the index of the next or the previous search match. The search wraps at the two ends. */
export function nextMatchIndex(index: number, count: number, step: 1 | -1): number {
    return (currentMatchIndex(index, count) + step + count) % count;
}

/** The text of the search count, for example "2 of 5". */
export function findCountText(query: string, count: number, index: number): string {
    if (!query) return '';
    return count ? `${index + 1} of ${count}` : 'No results';
}

/** The modes of the comment box. */
export type ComposerMode = 'comment' | 'ask' | 'note';

/** Returns the modes that the comment box shows, in the order of the buttons. */
export function composerModes(canComment: boolean, canAsk: boolean, canNote: boolean): ComposerMode[] {
    return [...(canComment ? ['comment' as const] : []), ...(canAsk ? ['ask' as const] : []), ...(canNote ? ['note' as const] : [])];
}

/** The placeholder text of the comment box. `lines` is a label such as "lines 3–5". */
export function composerPlaceholder(mode: ComposerMode, lines: string): string {
    return mode === 'ask' ? `Ask the agent about ${lines}` : mode === 'note' ? `Tell the agent what to do with ${lines}` : `Comment on ${lines}`;
}

/** The text of the submit button of the comment box. */
export function composerSubmitLabel(mode: ComposerMode): string {
    return mode === 'ask' ? 'Ask agent' : mode === 'note' ? 'Send to agent' : 'Add review comment';
}

/** A line that the diff shows now: its number and the top of its box, in pixels. */
export interface RenderedLine {
    line: number;
    top: number;
}

/** The line height that `seekDelta` uses when it cannot measure one. */
const DEFAULT_LINE_HEIGHT = 20;

/**
 * Returns the pixels to scroll so that a line that the diff does not show comes near `center`.
 * The diff shows only the lines near the view. The estimate uses the lines that show now.
 * Returns undefined when the line is between the first and the last line that show, or when no line shows.
 */
export function seekDelta(target: number, rendered: RenderedLine[], center: number): number | undefined {
    if (!rendered.length) return undefined;
    let first = rendered[0];
    let last = rendered[0];
    for (const item of rendered) {
        if (item.line < first.line) first = item;
        if (item.line > last.line) last = item;
    }
    if (target >= first.line && target <= last.line) return undefined;
    const measured = last.line > first.line ? (last.top - first.top) / (last.line - first.line) : 0;
    const lineHeight = measured > 0 && Number.isFinite(measured) ? measured : DEFAULT_LINE_HEIGHT;
    const anchor = target > last.line ? last : first;
    return anchor.top + (target - anchor.line) * lineHeight - center;
}
