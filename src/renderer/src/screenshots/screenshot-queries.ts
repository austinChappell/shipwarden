import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ScreenshotProgress, ScreenshotSide, ScreenshotState } from '@shared/screenshots';
import { keyRoots, queryClient } from '../query-client';

const api = window.shipwarden;

/** The query key of the screenshot state of a worktree. */
export function screenshotsKey(worktree: string) {
    return [...keyRoots.screenshots, worktree] as const;
}

/** The screenshots of the branch of a worktree. The data is local. Each write puts its result in the cache. */
export function useScreenshots(worktree: string) {
    return useQuery<ScreenshotState>({
        queryKey: screenshotsKey(worktree),
        queryFn: () => api.screenshots.get(worktree),
        staleTime: Number.POSITIVE_INFINITY,
        refetchInterval: false
    });
}

/**
 * One image as a data URL. The capture time is in the key, so a new capture loads the new image and an old image
 * stays in the cache until React Query removes it.
 */
export function useScreenshotImage(worktree: string, side: ScreenshotSide, page: string, capturedAt: number | undefined) {
    return useQuery<string | null>({
        queryKey: [...screenshotsKey(worktree), 'image', side, page, capturedAt ?? 0],
        queryFn: () => api.screenshots.image(worktree, side, page),
        enabled: capturedAt !== undefined,
        staleTime: Number.POSITIVE_INFINITY,
        refetchInterval: false
    });
}

/** Captures one side and writes the new state into the cache. */
export async function captureScreenshots(worktree: string, side: ScreenshotSide): Promise<ScreenshotState> {
    const state = await api.screenshots.capture(worktree, side);
    queryClient.setQueryData(screenshotsKey(worktree), state);
    return state;
}

/** Removes the screenshots of the branch and writes the empty state into the cache. */
export async function clearScreenshots(worktree: string): Promise<void> {
    await api.screenshots.clear(worktree);
    queryClient.setQueryData<ScreenshotState>(screenshotsKey(worktree), state => (state ? { ...state, set: null } : state));
}

/** The progress of the capture of a worktree, or undefined when no capture runs. */
export function useCaptureProgress(worktree: string): ScreenshotProgress | undefined {
    const [progress, setProgress] = useState<ScreenshotProgress>();
    useEffect(() => {
        setProgress(undefined);
        return api.screenshots.onProgress(next => {
            if (next.worktree !== worktree) return;
            setProgress(next.done >= next.total ? undefined : next);
        });
    }, [worktree]);
    return progress;
}
