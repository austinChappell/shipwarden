import { useEffect } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
import type { DraftKind } from '@shared/drafts';
import { clearDraftError, startDraft, stopDraft, useDraftRun } from '../app/agent-drafts';
import { confirmDialog } from './ConfirmDialog';
import { IconButton } from './ui';

interface Props {
    /** The worktree. The agent of its repository writes the draft in this folder. */
    worktree: string;
    kind: DraftKind;
    /** The key of the text draft of the box (see `useTextDraft`). The draft of the agent goes into it. */
    draftKey: string;
    /** The fallback text of the text draft of the box. */
    fallback?: string;
    /** For a commit message: true when the commit replaces the last commit. */
    amend?: boolean;
    /** The text in the box now. When it is not empty, the button asks before it replaces the text. */
    current: string;
    disabled?: boolean;
    /** Shows an error of the draft. Undefined clears the error. */
    onError(message: string | undefined): void;
}

const LABELS: Record<DraftKind, { start: string; replace: string }> = {
    commit: { start: 'Write the commit message with the agent', replace: 'Replace the commit message with a draft from the agent?' },
    pullRequest: { start: 'Write the description with the agent', replace: 'Replace the description with a draft from the agent?' }
};

/**
 * The ✨ button next to a commit message or a pull request description. It asks the agent of the repository for a
 * draft and puts the draft into the text draft of the box. The agent continues when the box closes. While the agent is
 * working, the button shows a spinner and a click stops the agent.
 */
export function DraftButton({ worktree, kind, draftKey, fallback, amend, current, disabled, onError }: Props) {
    const { running, error } = useDraftRun(draftKey);

    // The box shows the error one time. The error can come from a run that ended while the box was closed.
    useEffect(() => {
        if (!error) return;
        onError(error);
        clearDraftError(draftKey);
    }, [error, draftKey, onError]);

    const start = async () => {
        if (current.trim() && !(await confirmDialog({ title: LABELS[kind].replace, confirmLabel: 'Replace' }))) return;
        onError(undefined);
        await startDraft(draftKey, { worktree, kind, ...(amend ? { amend: true } : {}) }, fallback);
    };

    return running ? (
        <IconButton size="sm" icon={<LoaderCircle size={14} className="spin" />} label="Stop the agent" onClick={() => stopDraft(draftKey)} />
    ) : (
        <IconButton size="sm" icon={<Sparkles size={14} strokeWidth={1.7} />} label={LABELS[kind].start} disabled={disabled} onClick={() => void start()} />
    );
}
