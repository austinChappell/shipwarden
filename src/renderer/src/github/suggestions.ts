import type { ReviewThread } from '@shared/github';
import { lineLabel } from '@shared/ask-agent';
import { applySuggestion, threadSuggestionTarget } from '@shared/suggestion';
import { documents } from '../editor/documents';

/**
 * Applies a suggestion of a review thread to the file in the worktree. The user commits the change.
 * Returns a message for the user. Throws an error when the file does not change.
 */
export async function applyThreadSuggestion(worktree: string, thread: ReviewThread, lines: string[]): Promise<string> {
    const target = threadSuggestionTarget(thread);
    if (!target) {
        throw new Error('ShipWarden cannot find the old lines of this comment. Make the change manually.');
    }
    if (documents.isDirty(worktree, thread.path)) {
        throw new Error(`${thread.path} has unsaved changes. Save the file, then try again.`);
    }
    const text = await window.shipwarden.files.read(worktree, thread.path);
    const result = applySuggestion(text, target, lines);
    if (result.kind === 'stale') {
        throw new Error('The lines changed after the comment. ShipWarden did not change the file.');
    }
    if (result.kind === 'already') {
        return 'The file already has this change.';
    }
    await window.shipwarden.files.write(worktree, thread.path, result.text);
    return `ShipWarden changed ${thread.path}, ${lineLabel(result.startLine, result.line)}. Commit the change.`;
}
