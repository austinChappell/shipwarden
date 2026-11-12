/** Joins class names. It ignores the values that are false, null, undefined, or empty. */
export function cx(...names: (string | false | null | undefined)[]): string {
    return names.filter(Boolean).join(' ');
}
