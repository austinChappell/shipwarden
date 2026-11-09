import { useEffect, useRef, useState } from 'react';

/**
 * Returns a number that increases when a folder of the worktree changes.
 * `folders` returns the folders to look at, relative to the root. An empty string is the root.
 * A viewer adds the number to its file URL, so that the file loads again after an agent changes it.
 */
export function useFolderVersion(root: string, folders: () => Iterable<string>): number {
    const [version, setVersion] = useState(0);
    const foldersRef = useRef(folders);
    foldersRef.current = folders;

    useEffect(() => {
        const api = window.shipwarden.files;
        api.watch(root);
        const stop = api.onChanged(event => {
            if (event.root !== root) return;
            const changed = new Set(event.directories);
            for (const folder of foldersRef.current()) {
                if (changed.has(folder)) {
                    setVersion(value => value + 1);
                    return;
                }
            }
        });
        return () => {
            stop();
            api.unwatch(root);
        };
    }, [root]);

    return version;
}
