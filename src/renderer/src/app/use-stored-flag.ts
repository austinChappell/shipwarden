import { useState } from 'react';
import { readFlag } from './stored-flag';

/**
 * An on/off value that the browser storage keeps across starts. Returns the value and a function that toggles it.
 * When the storage is not available, the value stays for this session only.
 */
export function useStoredFlag(storageKey: string, fallback: boolean): [boolean, () => void] {
    const [value, setValue] = useState(() => {
        try {
            return readFlag(localStorage.getItem(storageKey), fallback);
        } catch {
            return fallback;
        }
    });
    const toggle = () => setValue(current => {
        try {
            localStorage.setItem(storageKey, String(!current));
        } catch {
            // The value stays for this session only.
        }
        return !current;
    });
    return [value, toggle];
}
