import { useCallback, useEffect, useRef, useState } from 'react';
import type { BranchStatus } from '@shared/github';

const POLL_MS = 30_000;

export interface BranchStatusState {
    status: BranchStatus | null | undefined;
    loading: boolean;
    error?: string;
    refresh(): Promise<void>;
}

function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/**
 * Loads the GitHub state of a worktree: the branch, its pull request and the commit for checks.
 * It loads again every 30 seconds while `active` is true.
 * `status` is undefined before the first load and null when the worktree has no GitHub remote.
 */
export function useBranchStatus(root: string | undefined, active: boolean): BranchStatusState {
    const [status, setStatus] = useState<BranchStatus | null>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>();
    const rootRef = useRef(root);
    rootRef.current = root;

    const refresh = useCallback(async () => {
        const current = rootRef.current;
        if (!current) {
            return;
        }
        setLoading(true);
        try {
            const result = await window.shipwarden.github.status(current);
            if (rootRef.current === current) {
                setStatus(result);
                setError(undefined);
            }
        } catch (err) {
            if (rootRef.current === current) {
                setError(errorText(err));
            }
        } finally {
            setLoading(false);
        }
    }, []);

    // biome-ignore lint/correctness/useExhaustiveDependencies: The effect clears the old status when the worktree changes.
    useEffect(() => {
        setStatus(undefined);
        setError(undefined);
    }, [root]);

    useEffect(() => {
        if (!root || !active) {
            return;
        }
        refresh();
        const timer = setInterval(refresh, POLL_MS);
        return () => clearInterval(timer);
    }, [root, active, refresh]);

    return { status, loading, error, refresh };
}
