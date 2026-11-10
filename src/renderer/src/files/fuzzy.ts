export interface FuzzyMatch {
    path: string;
    score: number;
}

/**
 * Scores a path against a query. The query characters must occur in order in the path.
 * Returns undefined when the path does not match.
 * Higher scores are better: matches in the file name, consecutive matches and matches at word starts.
 * The match ignores case when `caseSensitive` is false.
 */
export function fuzzyScore(path: string, query: string, caseSensitive = false): number | undefined {
    const text = caseSensitive ? path : path.toLowerCase();
    const needle = (caseSensitive ? query : query.toLowerCase()).replace(/\s+/g, '');
    if (!needle) {
        return 0;
    }
    const nameStart = text.lastIndexOf('/') + 1;
    let score = 0;
    let position = -1;
    let previous = -2;
    for (const char of needle) {
        const found = text.indexOf(char, position + 1);
        if (found === -1) {
            return undefined;
        }
        score += 1;
        if (found === previous + 1) {
            score += 4;
        }
        if (found >= nameStart) {
            score += 2;
        }
        const before = text[found - 1];
        if (found === 0 || before === '/' || before === '-' || before === '_' || before === '.') {
            score += 3;
        }
        previous = found;
        position = found;
    }
    // Prefer short paths and exact file name matches.
    if (text.slice(nameStart) === needle || text.slice(nameStart).startsWith(needle)) {
        score += 10;
    }
    return score - path.length * 0.01;
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
