import type { DiffSide } from './github';

/** One line of a pull request diff that contains the search text. */
export interface PatchMatch {
    path: string;
    /** LEFT for a removed line. RIGHT for an added line or a context line. */
    side: DiffSide;
    line: number;
    /** The text of the line, without the "+", "-" or " " prefix. */
    text: string;
}

/** One line of a "@@" hunk. A context line has both line numbers. */
export interface HunkLine {
    kind: 'added' | 'removed' | 'context';
    /** The line number in the old version. Undefined for an added line. */
    left?: number;
    /** The line number in the new version. Undefined for a removed line. */
    right?: number;
    /** The text of the line, without the "+", "-" or " " prefix. */
    text: string;
}

/** Returns the lines of the "@@" hunks of a patch. A "\ No newline at end of file" line is not a line of the file. */
export function hunkLines(patch: string | undefined): HunkLine[] {
    const result: HunkLine[] = [];
    if (!patch) return result;
    let left = 0;
    let right = 0;
    for (const raw of patch.split('\n')) {
        const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (header) {
            left = Number(header[1]);
            right = Number(header[2]);
            continue;
        }
        if ((left === 0 && right === 0) || raw.startsWith('\\')) continue;
        const text = raw.slice(1);
        if (raw.startsWith('+')) result.push({ kind: 'added', right: right++, text });
        else if (raw.startsWith('-')) result.push({ kind: 'removed', left: left++, text });
        else result.push({ kind: 'context', left: left++, right: right++, text });
    }
    return result;
}

/** The most matches that a search returns. */
export const MAX_MATCHES = 2000;

/**
 * Finds the diff lines that contain a text, in file order. The search reads the "@@" hunks of each file,
 * so it does not find text in the hidden lines of a file or in a file without a patch (binary or too large).
 * Without `caseSensitive`, the search ignores case.
 */
export function searchPatches(files: readonly { path: string; patch?: string }[], query: string, caseSensitive = false): PatchMatch[] {
    if (!query) return [];
    const wanted = caseSensitive ? query : query.toLowerCase();
    const matches: PatchMatch[] = [];
    for (const file of files) {
        for (const item of hunkLines(file.patch)) {
            if (!(caseSensitive ? item.text : item.text.toLowerCase()).includes(wanted)) continue;
            const removed = item.kind === 'removed';
            matches.push({ path: file.path, side: removed ? 'LEFT' : 'RIGHT', line: (removed ? item.left : item.right)!, text: item.text });
            if (matches.length >= MAX_MATCHES) return matches;
        }
    }
    return matches;
}
