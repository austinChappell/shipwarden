export interface FuzzyMatch {
    path: string;
    score: number;
}

/** Each match kind has its own score range. A match of a better kind always ranks higher. */
const TIER = 100_000;

/** The kinds of match, worst first. */
enum Tier {
    /** The query characters occur in order, across the full path. */
    ScatteredInPath = 1,
    /** The query characters occur in order, in the file name. */
    ScatteredInName,
    /** The query occurs in one piece in the folder path. */
    InPath,
    /** The query occurs in one piece in the file name. "-", "_" and spaces in the name do not count. */
    InName,
    /** The file name starts with the query. */
    NamePrefix,
    /** The file name without its extension is the same as the query. */
    ExactName
}

function isSeparator(char: string | undefined): boolean {
    return char === '/' || char === '-' || char === '_' || char === '.' || char === ' ';
}

/** Returns true when the character at `index` starts a word: after a separator, or a capital after a lowercase letter. */
function isWordStart(original: string, index: number): boolean {
    if (index === 0) {
        return true;
    }
    const before = original[index - 1];
    if (isSeparator(before)) {
        return true;
    }
    const char = original[index];
    return char !== char.toLowerCase() && before === before.toLowerCase() && before !== before.toUpperCase();
}

/**
 * Returns the best score of the query characters in order in `text`, or undefined when they do not occur in order.
 * Each matched character gives 1 point. A match at a word start gives 3 more points. A match right after the
 * previous match gives 4 more points. The function finds the best placement, not the first placement.
 */
function scatteredScore(original: string, text: string, needle: string): number | undefined {
    const none = Number.NEGATIVE_INFINITY;
    // best[j] is the best score of the needle so far, with its last character at index j of the text.
    let best: number[] = [];
    for (let index = 0; index < needle.length; index += 1) {
        const next: number[] = new Array(text.length).fill(none);
        let bestBefore = index === 0 ? 0 : none;
        for (let j = 0; j < text.length; j += 1) {
            if (index > 0 && j > 0) {
                // A match at j can follow any match before j - 1 without the consecutive bonus.
                bestBefore = j > 1 ? Math.max(bestBefore, best[j - 2]) : bestBefore;
            }
            if (text[j] !== needle[index]) {
                continue;
            }
            const value = 1 + (isWordStart(original, j) ? 3 : 0);
            const consecutive = index > 0 && j > 0 && best[j - 1] !== none ? best[j - 1] + 4 : none;
            const previous = Math.max(bestBefore, consecutive);
            if (previous !== none) {
                next[j] = previous + value;
            }
        }
        best = next;
    }
    const result = Math.max(none, ...best);
    return result === none ? undefined : result;
}

/** Returns true when the query characters occur in order in the text. This check is fast. */
function isSubsequence(text: string, needle: string): boolean {
    let position = -1;
    for (const char of needle) {
        position = text.indexOf(char, position + 1);
        if (position === -1) {
            return false;
        }
    }
    return true;
}

/**
 * Scores a path against a query. The query characters must occur in order in the path.
 * Returns undefined when the path does not match.
 * Higher scores are better. The kind of match counts first (see `Tier`): an exact file name is best, and scattered
 * characters across the path are worst. Inside one kind, a match at a word start, a short file name and a short path
 * rank higher.
 * The match ignores case when `caseSensitive` is false.
 */
export function fuzzyScore(path: string, query: string, caseSensitive = false): number | undefined {
    const text = caseSensitive ? path : path.toLowerCase();
    const needle = (caseSensitive ? query : query.toLowerCase()).replace(/\s+/g, '');
    if (!needle) {
        return 0;
    }
    if (!isSubsequence(text, needle)) {
        return undefined;
    }
    const nameStart = text.lastIndexOf('/') + 1;
    const name = text.slice(nameStart);
    const originalName = path.slice(nameStart);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    // Short names and short paths rank higher inside one kind of match.
    const lengthPenalty = name.length * 0.5 + path.length * 0.01;

    const tiered = (tier: Tier, bonus: number) => tier * TIER + bonus - lengthPenalty;
    if (stem === needle || name === needle) {
        return tiered(Tier.ExactName, 0);
    }
    if (name.startsWith(needle)) {
        return tiered(Tier.NamePrefix, 0);
    }
    const inName = name.indexOf(needle);
    if (inName !== -1) {
        return tiered(Tier.InName, (isWordStart(originalName, inName) ? 50 : 0) - inName * 0.1);
    }
    if (name.replace(/[-_ ]/g, '').includes(needle)) {
        return tiered(Tier.InName, 0);
    }
    const inPath = text.lastIndexOf(needle);
    if (inPath !== -1) {
        return tiered(Tier.InPath, isWordStart(path, inPath) ? 50 : 0);
    }
    const scatteredName = scatteredScore(originalName, name, needle);
    if (scatteredName !== undefined) {
        return tiered(Tier.ScatteredInName, scatteredName * 10);
    }
    return tiered(Tier.ScatteredInPath, (scatteredScore(path, text, needle) ?? 0) * 10);
}

/**
 * Returns the indexes of the path characters that match the query, in ascending order. The page highlights these characters.
 * A match in one piece in the file name is best. A match in one piece in the path is second.
 * Else each query character matches the last possible character. Thus the most characters are in the file name.
 * Returns an empty list when the path does not match.
 */
export function fuzzyPositions(path: string, query: string, caseSensitive = false): number[] {
    const text = caseSensitive ? path : path.toLowerCase();
    const needle = (caseSensitive ? query : query.toLowerCase()).replace(/\s+/g, '');
    if (!needle) {
        return [];
    }
    const range = (start: number) => Array.from(needle, (_, index) => start + index);
    const nameStart = text.lastIndexOf('/') + 1;
    const inName = text.indexOf(needle, nameStart);
    if (inName !== -1) {
        return range(inName);
    }
    const inPath = text.lastIndexOf(needle);
    if (inPath !== -1) {
        return range(inPath);
    }
    const positions: number[] = [];
    let position = text.length;
    for (let index = needle.length - 1; index >= 0; index -= 1) {
        // lastIndexOf with a negative start finds nothing, so the loop stops at the start of the text.
        position = position === 0 ? -1 : text.lastIndexOf(needle[index], position - 1);
        if (position === -1) {
            return [];
        }
        positions.push(position);
    }
    return positions.reverse();
}

/** Returns the best matches, best first. */
export function fuzzyFilter(paths: readonly string[], query: string, limit = 200, caseSensitive = false): FuzzyMatch[] {
    const matches: FuzzyMatch[] = [];
    for (const path of paths) {
        const score = fuzzyScore(path, query, caseSensitive);
        if (score !== undefined) {
            matches.push({ path, score });
        }
    }
    return matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}
