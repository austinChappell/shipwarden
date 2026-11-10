import { useEffect, useRef } from 'react';
import { EMPTY_NAV_HISTORY, recordLocation, stepHistory, type NavLocation } from '@shared/nav-history';

/**
 * The back and forward history (⌘[ and ⌘]). Each change of the location adds an entry.
 * An undefined location adds no entry. Returns the function that moves one step and returns the new location.
 */
export function useNavHistory(location: NavLocation | undefined) {
    const history = useRef(EMPTY_NAV_HISTORY);
    // biome-ignore lint/correctness/useExhaustiveDependencies: The caller makes a new location object on each render. Only a change of a field adds an entry.
    useEffect(() => {
        if (location) history.current = recordLocation(history.current, location);
    }, [location?.view, location?.worktree, location?.tab, location?.repo]);

    return (step: 1 | -1, isValid: (location: NavLocation) => boolean): NavLocation | undefined => {
        const result = stepHistory(history.current, step, isValid);
        if (!result) return undefined;
        history.current = result.history;
        return result.location;
    };
}
