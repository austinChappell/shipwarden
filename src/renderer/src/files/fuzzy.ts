export interface FuzzyMatch {
    path: string;
    score: number;
}

/**
 * Scores a path against a query. The query characters must occur in order in the path.
 * Returns undefined when the path does not match.
 * Higher scores are better: matches in the file name, consecutive matches and matches at word starts.
 */
export function fuzzyScore(path: string, query: string): number | undefined {
    const text = path.toLowerCase();
    const needle = query.toLowerCase().replace(/\s+/g, '');
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

/** Returns the best matches, best first. */
export function fuzzyFilter(paths: readonly string[], query: string, limit = 200): FuzzyMatch[] {
    const matches: FuzzyMatch[] = [];
    for (const path of paths) {
        const score = fuzzyScore(path, query);
        if (score !== undefined) {
            matches.push({ path, score });
        }
    }
    return matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}
