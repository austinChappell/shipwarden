/** Matches a last line such as "🤖 Generated with [Claude Code](https://claude.com/claude-code)". */
const GENERATED_LINE = /\n+\s*(?:\p{Extended_Pictographic}\uFE0F?\s*)?(Generated (?:with|by) .+)\s*$/u;

/** Removes the "Generated with" line from the end of a description. The card shows this line in its footer. */
export function splitFooter(body: string): { text: string; footer: string | null } {
    const match = GENERATED_LINE.exec(`\n${body}`);
    if (!match) return { text: body, footer: null };
    return { text: `\n${body}`.slice(0, match.index).trim(), footer: match[1].trim() };
}

/** Gets one or two capital letters from a login, for the avatar. */
export function initials(login: string): string {
    const parts = login.split(/[-_.\s]+|(?=[A-Z])/).filter(Boolean);
    const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : login.slice(0, 2);
    return letters.toUpperCase();
}
