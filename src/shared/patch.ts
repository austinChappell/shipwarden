/** The fields of a changed file of a pull request that a unified patch needs. */
export interface PatchSource {
    path: string;
    previousPath?: string;
    /** added, removed, modified, renamed, copied, changed or unchanged. */
    status: string;
    /** The hunks from the GitHub files API. GitHub leaves them out for a large or binary file. */
    patch?: string;
}

/**
 * Makes a complete unified patch from the hunks of the GitHub files API. GitHub sends only the "@@" hunks,
 * without the "diff --git", "---" and "+++" lines that a patch parser needs for the file names.
 * Returns undefined when GitHub sent no hunks.
 */
export function unifiedPatch(file: PatchSource): string | undefined {
    if (!file.patch) return undefined;
    const before = file.previousPath ?? file.path;
    const oldName = file.status === 'added' ? '/dev/null' : `a/${before}`;
    const newName = file.status === 'removed' ? '/dev/null' : `b/${file.path}`;
    const header = [`diff --git a/${before} b/${file.path}`];
    if (file.status === 'added') header.push('new file mode 100644');
    if (file.status === 'removed') header.push('deleted file mode 100644');
    // The parser marks a rename only with a "similarity index" line. GitHub does not send the value, so it is a placeholder.
    if (file.previousPath && file.previousPath !== file.path) header.push('similarity index 90%', `rename from ${file.previousPath}`, `rename to ${file.path}`);
    header.push(`--- ${oldName}`, `+++ ${newName}`);
    return `${header.join('\n')}\n${file.patch.endsWith('\n') ? file.patch : `${file.patch}\n`}`;
}
