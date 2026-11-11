/**
 * The "@" and "#" references in a comment box: "@login" tags a user, and "#123" links to an issue or a pull request.
 * These functions find the reference at the cursor and put the selected item into the text.
 */

/** The reference that the user types now. */
export interface ActiveMention {
    /** "@" for a user, "#" for an issue or a pull request. */
    trigger: '@' | '#';
    /** The text after the trigger, up to the cursor. */
    query: string;
    /** The index of the trigger in the text. */
    start: number;
}

/**
 * A trigger at the start of the text, or after a space or "(", and then up to 39 word characters or "-".
 * 39 is the maximum length of a GitHub login.
 */
const ACTIVE_PATTERN = /(?<![^\s(])([@#])([\w-]{0,39})$/;

/** Returns the reference that ends at the cursor. Returns undefined in a code block or in inline code. */
export function activeMention(text: string, caret: number): ActiveMention | undefined {
    const before = text.slice(0, caret);
    const match = ACTIVE_PATTERN.exec(before);
    if (!match) return undefined;
    const start = match.index;
    if (insideCode(before.slice(0, start))) return undefined;
    return { trigger: match[1] as '@' | '#', query: match[2], start };
}

/** True when the end of the text is in a fenced code block or in inline code. */
function insideCode(text: string): boolean {
    const fences = text.match(/^\s*(```|~~~)/gm)?.length ?? 0;
    if (fences % 2 === 1) return true;
    const line = text.slice(text.lastIndexOf('\n') + 1);
    return (line.match(/`/g)?.length ?? 0) % 2 === 1;
}

/**
 * Replaces the reference at the cursor with `value` and a space. Returns the new text and the new cursor position.
 * When a space follows the cursor, the function adds no second space.
 */
export function applyMention(text: string, caret: number, mention: ActiveMention, value: string): { text: string; caret: number } {
    const after = text.slice(caret);
    const space = /^\s/.test(after) ? '' : ' ';
    const inserted = `${value}${space}`;
    return { text: text.slice(0, mention.start) + inserted + after, caret: mention.start + inserted.length + (space ? 0 : 1) };
}

/**
 * Returns the logins that match the query, with no duplicates (case is not important).
 * The logins that start with the query come first. The order of `logins` stays in each group.
 */
export function rankLogins(logins: string[], query: string, limit = 8): string[] {
    const needle = query.toLowerCase();
    const seen = new Set<string>();
    const starts: string[] = [];
    const contains: string[] = [];
    for (const login of logins) {
        const key = login.toLowerCase();
        if (!login || seen.has(key)) continue;
        seen.add(key);
        if (key.startsWith(needle)) starts.push(login);
        else if (key.includes(needle)) contains.push(login);
    }
    return [...starts, ...contains].slice(0, limit);
}

/** The web address of the repository of a pull request, from the address of the pull request. */
export function repoUrlOf(pullRequestUrl: string): string | undefined {
    const match = /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+\/?$/.exec(pullRequestUrl);
    return match?.[1];
}

/** A part of a text: plain text, a user ("@login") or an issue or pull request ("#123"). */
export type ReferencePart = { kind: 'text'; text: string } | { kind: 'user'; text: string; login: string } | { kind: 'issue'; text: string; number: number };

/**
 * "@login" or "#123", after the start of the text or a character that is not a word character, "/", "@", "." or "#".
 * The reference must not continue with a word character or "-". An email address such as "a@b.com" does not match.
 */
const REFERENCE_PATTERN = /(?<![\w/@.#-])(?:@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))|#(\d{1,9}))(?![\w-])/g;

/** Splits a text into plain text, users and issues. Returns one text part when the text has no reference. */
export function splitReferences(text: string): ReferencePart[] {
    const parts: ReferencePart[] = [];
    let last = 0;
    for (const match of text.matchAll(REFERENCE_PATTERN)) {
        const index = match.index ?? 0;
        if (index > last) parts.push({ kind: 'text', text: text.slice(last, index) });
        if (match[1]) parts.push({ kind: 'user', text: match[0], login: match[1] });
        else parts.push({ kind: 'issue', text: match[0], number: Number(match[2]) });
        last = index + match[0].length;
    }
    if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
    return parts;
}
