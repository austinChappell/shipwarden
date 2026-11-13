import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
import type { DraftKind } from '@shared/drafts';
import { errorText } from '../util';
import { confirmDialog } from './ConfirmDialog';
import { IconButton } from './ui';

const api = window.shipwarden.ask;

interface Props {
    /** The worktree. The agent of its repository writes the draft in this folder. */
    worktree: string;
    kind: DraftKind;
    /** For a commit message: true when the commit replaces the last commit. */
    amend?: boolean;
    /** The text in the box now. When it is not empty, the button asks before it replaces the text. */
    current: string;
    disabled?: boolean;
    /** Puts the draft into the box. */
    onDraft(text: string): void;
    /** Shows an error of the draft. Undefined clears the error. */
    onError(message: string | undefined): void;
}

const LABELS: Record<DraftKind, { start: string; replace: string }> = {
    commit: { start: 'Write the commit message with the agent', replace: 'Replace the commit message with a draft from the agent?' },
    pullRequest: { start: 'Write the description with the agent', replace: 'Replace the description with a draft from the agent?' }
};

/**
 * The ✨ button next to a commit message or a pull request description. It asks the agent of the repository for a
 * draft and puts the draft into the box. While the agent works, the button shows a spinner and a click stops the agent.
 */
export function DraftButton({ worktree, kind, amend, current, disabled, onDraft, onError }: Props) {
    const [running, setRunning] = useState<string>();
    const runningRef = useRef<string | undefined>(undefined);
    runningRef.current = running;

    // The agent stops when the box closes, so it does not use tokens for a draft that nobody sees.
    useEffect(
        () => () => {
            if (runningRef.current) void api.cancel(runningRef.current);
        },
        []
    );

    const start = async () => {
        if (current.trim() && !(await confirmDialog({ title: LABELS[kind].replace, confirmLabel: 'Replace' }))) return;
        const id = `draft-${crypto.randomUUID()}`;
        runningRef.current = id;
        setRunning(id);
        onError(undefined);
        try {
            const result = await api.draft({ id, worktree, kind, ...(amend ? { amend: true } : {}) });
            if (runningRef.current === id) onDraft(result.text);
        } catch (err) {
            // A stop by the user is not an error.
            if (runningRef.current === id) onError(errorText(err));
        } finally {
            setRunning(current => (current === id ? undefined : current));
        }
    };

    const stop = () => {
        if (!running) return;
        void api.cancel(running);
        // The ref changes now, so the rejection of the stopped run does not show an error.
        runningRef.current = undefined;
        setRunning(undefined);
    };

    return running ? (
        <IconButton size="sm" icon={<LoaderCircle size={14} className="spin" />} label="Stop the agent" onClick={stop} />
    ) : (
        <IconButton size="sm" icon={<Sparkles size={14} strokeWidth={1.7} />} label={LABELS[kind].start} disabled={disabled} onClick={() => void start()} />
    );
}
