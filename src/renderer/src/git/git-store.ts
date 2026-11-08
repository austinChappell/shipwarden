import { useEffect, useState } from 'react';
import type { GitChanges } from '@shared/git';

/** The time between two reads of `git status` while a worktree shows. A local `git status` is fast. */
const POLL_MS = 4000;

type Listener = () => void;
const listeners = new Set<Listener>();

/** Tells the views that the changes of a worktree changed, for example after a stage or a commit. */
export function gitChanged(): void {
    listeners.forEach(listener => listener());
}

/** Calls the listener after each `gitChanged`. Returns a function that removes the listener. */
export function onGitChanged(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * The local changes of a worktree. They load again every 4 seconds while the window shows, when a file of the
 * worktree changes, when the window gets the focus, and after `gitChanged`.
 */
export function useGitChanges(worktree: string | undefined): { changes: GitChanges | undefined; error: string | undefined; reload(): void } {
    const [changes, setChanges] = useState<GitChanges>();
    const [error, setError] = useState<string>();
    const [version, setVersion] = useState(0);

    useEffect(() => {
        setChanges(undefined);
        setError(undefined);
    }, [worktree]);

    useEffect(() => {
        if (!worktree) return;
        let current = true;
        let running = false;
        const load = async () => {
            if (running || document.visibilityState !== 'visible') return;
            running = true;
            try {
                const next = await window.shipwarden.git.changes(worktree);
                if (current) {
                    setChanges(next);
                    setError(undefined);
                }
            } catch (err) {
                if (current) setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));
            } finally {
                running = false;
            }
        };
        void load();
        const timer = setInterval(() => void load(), POLL_MS);
        const offFiles = window.shipwarden.files.onChanged(event => event.root === worktree && void load());
        const offGit = onGitChanged(() => void load());
        const onFocus = () => void load();
        window.addEventListener('focus', onFocus);
        return () => {
            current = false;
            clearInterval(timer);
            offFiles();
            offGit();
            window.removeEventListener('focus', onFocus);
        };
    }, [worktree, version]);

    return { changes, error, reload: () => setVersion(value => value + 1) };
}
