import { useEffect, useRef } from 'react';
import { CircleAlert, CircleCheck, LoaderCircle, X } from 'lucide-react';
import type { NotificationTarget } from '@shared/api';
import { stepLabel, useBackgroundCreations, worktreeProgress, type WorktreeProgress } from '../app/worktree-progress';
import { Button, IconButton } from './ui';

const api = window.shipwarden;

interface Props {
    /** The name of a repository in the UI. */
    repoLabel(repo: string): string;
    /** Opens a place in the app, the same as a click on a notification. */
    openTarget(target: NotificationTarget): void;
}

/** The text of the step that runs now. */
function currentStep(entry: WorktreeProgress): string {
    const step = entry.steps.at(-1);
    return step ? stepLabel(step, true) : 'Starting…';
}

/**
 * The notices of the worktree creations that continue after "Notify me when ready". Each notice shows the step that runs
 * now, then "Open" when the worktree is ready, or the error. When the window is not in front, a macOS notification
 * also tells the user that the worktree is ready.
 */
export function WorktreeProgressNotices({ repoLabel, openTarget }: Props) {
    const entries = useBackgroundCreations();
    const notified = useRef(new Set<string>());

    useEffect(() => {
        for (const entry of entries) {
            if (entry.status === 'running' || notified.current.has(entry.id)) continue;
            notified.current.add(entry.id);
            if (document.hasFocus()) continue;
            api.notifications.show(
                entry.status === 'ready' && entry.worktree
                    ? {
                          title: `${entry.branch} is ready`,
                          body: `The new worktree in ${repoLabel(entry.repoPath)} is ready.`,
                          target: { view: 'worktree', worktreePath: entry.worktree.path }
                      }
                    : { title: `ShipWarden did not create ${entry.branch}`, body: entry.error }
            );
        }
    }, [entries, repoLabel]);

    if (entries.length === 0) return null;
    return (
        <div className="worktree-progress-notices">
            {entries.map(entry => (
                <div key={entry.id} className={`worktree-progress-notice ${entry.status}`} role="status">
                    {entry.status === 'running' && <LoaderCircle size={16} className="spin worktree-progress-icon" />}
                    {entry.status === 'ready' && <CircleCheck size={16} strokeWidth={1.8} className="worktree-progress-icon" />}
                    {entry.status === 'failed' && <CircleAlert size={16} strokeWidth={1.8} className="worktree-progress-icon" />}
                    <div className="worktree-progress-text">
                        <strong>
                            {entry.status === 'running'
                                ? `Creating ${entry.branch}`
                                : entry.status === 'ready'
                                  ? `${entry.branch} is ready`
                                  : `ShipWarden did not create ${entry.branch}`}
                        </strong>
                        <span>{entry.status === 'running' ? currentStep(entry) : entry.status === 'ready' ? repoLabel(entry.repoPath) : entry.error}</span>
                    </div>
                    {entry.status === 'ready' && entry.worktree && (
                        <Button
                            onClick={() => {
                                if (entry.worktree) openTarget({ view: 'worktree', worktreePath: entry.worktree.path });
                                worktreeProgress.dismiss(entry.id);
                            }}
                        >
                            Open
                        </Button>
                    )}
                    {entry.status !== 'running' && (
                        <IconButton icon={<X size={14} strokeWidth={1.8} />} label="Close" onClick={() => worktreeProgress.dismiss(entry.id)} />
                    )}
                </div>
            ))}
        </div>
    );
}
