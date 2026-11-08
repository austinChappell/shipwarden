import { useEffect, useState } from 'react';
import type { FetchResult, GitChanges } from '@shared/git';

/** The time between two reads of `git status` while a worktree shows. A local `git status` is fast. */
const POLL_MS = 4000;
/** The time between two requests for a background fetch. The main process fetches a repository at most every 5 minutes. */
const FETCH_CHECK_MS = 60_000;

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
export function useGitChanges(worktree: string | undefined): {
    changes: GitChanges | undefined;
    error: string | undefined;
    /** The last background fetch of the upstream remote. */
    fetched: FetchResult | undefined;
    /** Reads the changes again. With `fetch`, it also fetches the remote now. */
    reload(fetch?: boolean): void;
} {
    const [changes, setChanges] = useState<GitChanges>();
    const [error, setError] = useState<string>();
    const [fetched, setFetched] = useState<FetchResult>();
    const [version, setVersion] = useState(0);
    const [forceFetch, setForceFetch] = useState(0);

    useEffect(() => {
        setChanges(undefined);
        setError(undefined);
        setFetched(undefined);
    }, [worktree]);

    // A background fetch, so the status knows the new commits of the upstream. The main process limits it to one
    // fetch every 5 minutes for each repository. A fetch runs only while the window shows.
    useEffect(() => {
        if (!worktree) return;
        let current = true;
        let lastAt: number | undefined;
        const fetchNow = async (force: boolean) => {
            if (document.visibilityState !== 'visible') return;
            try {
                const result = await window.shipwarden.git.fetch(worktree, force);
                if (!current) return;
                setFetched(result);
                // Only a new fetch can change the commits to pull.
                if (result.at !== lastAt) {
                    lastAt = result.at;
                    gitChanged();
                }
            } catch {
                // A worktree that is gone: the status shows the error.
            }
        };
        void fetchNow(forceFetch > 0);
        const timer = setInterval(() => void fetchNow(false), FETCH_CHECK_MS);
        const onFocus = () => void fetchNow(false);
        window.addEventListener('focus', onFocus);
        return () => {
            current = false;
            clearInterval(timer);
            window.removeEventListener('focus', onFocus);
        };
    }, [worktree, forceFetch]);

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

    return {
        changes,
        error,
        fetched,
        reload: (fetch = false) => {
            setVersion(value => value + 1);
            if (fetch) setForceFetch(value => value + 1);
        }
    };
}
