import { createTwoFilesPatch } from 'diff';

/**
 * Returns the unified patch of two versions of a file. The diff view makes its hunks with the same function and the
 * same default options, so the patch has the lines that the diff view shows before the user expands hidden lines.
 */
export function changePatch(original: string, modified: string): string {
    return createTwoFilesPatch('a', 'b', original, modified);
}
