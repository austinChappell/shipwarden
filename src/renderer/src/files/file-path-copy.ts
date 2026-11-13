type Listener = (root: string, path: string) => void;

const listeners = new Set<Listener>();

/**
 * Copies a text to the clipboard as the path of a file, and tells the path bars of that file.
 * The path bar then shows a check mark, also when the copy comes from ⇧⌘C.
 */
export async function copyFilePath(root: string, path: string, text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
    for (const listener of listeners) listener(root, path);
}

/** Calls `listener` after each copy of a file path. Returns a function that removes the listener. */
export function onFilePathCopied(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
