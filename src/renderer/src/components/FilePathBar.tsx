import { Fragment, useEffect, useState, type MouseEvent } from 'react';
import { Check, ChevronRight, Copy, FolderOpen, ListTree } from 'lucide-react';
import { copyFilePath, onFilePathCopied } from '../files/file-path-copy';
import { errorText } from '../util';
import { showContextMenu, type ContextMenuItem } from './ContextMenu';
import { IconButton } from './ui';

interface Props {
    root: string;
    /** The path of the file, relative to the root. */
    path: string;
    onError(message: string): void;
    /** Shows the file in the file explorer of the right panel. Without it, the bar has no button for it. */
    onRevealInExplorer?(): void;
}

/** The time that the copy button shows its check mark. */
const COPIED_MS = 1500;

/**
 * The bar at the top of a file tab. It shows the relative path of the file, with the folders in a muted color.
 * The buttons copy the relative path (⇧⌘C), show the file in the file explorer (⇧⌘E) and show the file in Finder (⌥⌘R).
 * A right click on the bar opens a menu with the same actions and "Copy path".
 */
export function FilePathBar({ root, path, onError, onRevealInExplorer }: Props) {
    const [copied, setCopied] = useState(false);
    const parts = path.split('/');
    const name = parts.pop() ?? path;
    const absolute = `${root}/${path}`;

    useEffect(
        () =>
            onFilePathCopied((copiedRoot, copiedPath) => {
                if (copiedRoot === root && copiedPath === path) setCopied(true);
            }),
        [root, path]
    );

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), COPIED_MS);
        return () => clearTimeout(timer);
    }, [copied]);

    const copy = (text: string) => void copyFilePath(root, path, text).catch(error => onError(errorText(error)));
    const revealInFinder = () => void window.shipwarden.files.reveal(root, path).catch(error => onError(errorText(error)));

    const openMenu = async (event: MouseEvent) => {
        event.preventDefault();
        const items: ContextMenuItem[] = [
            { id: 'copy-relative-path', label: 'Copy relative path' },
            { id: 'copy-path', label: 'Copy path' },
            { type: 'separator' },
            ...(onRevealInExplorer ? [{ id: 'reveal-explorer', label: 'Reveal in file explorer' }] : []),
            { id: 'reveal-finder', label: 'Reveal in Finder' }
        ];
        switch (await showContextMenu(items)) {
            case 'copy-relative-path':
                copy(path);
                break;
            case 'copy-path':
                copy(absolute);
                break;
            case 'reveal-explorer':
                onRevealInExplorer?.();
                break;
            case 'reveal-finder':
                revealInFinder();
                break;
        }
    };

    return (
        <div className="file-path-bar" onContextMenu={openMenu}>
            <span className="file-path" title={absolute}>
                {parts.map((part, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Two folders of a path can have the same name.
                    <Fragment key={index}>
                        <span className="file-path-folder">{part}</span>
                        <ChevronRight size={12} strokeWidth={1.8} className="file-path-separator" aria-hidden />
                    </Fragment>
                ))}
                <span className="file-path-name">{name}</span>
            </span>
            <span className="file-path-actions">
                <IconButton
                    size="sm"
                    label="Copy relative path (⇧⌘C)"
                    title={copied ? 'Copied' : 'Copy relative path (⇧⌘C)'}
                    className={copied ? 'copied' : undefined}
                    icon={copied ? <Check size={14} strokeWidth={1.8} /> : <Copy size={14} strokeWidth={1.6} />}
                    onClick={() => copy(path)}
                />
                {onRevealInExplorer && (
                    <IconButton size="sm" label="Reveal in file explorer (⇧⌘E)" icon={<ListTree size={14} strokeWidth={1.6} />} onClick={onRevealInExplorer} />
                )}
                <IconButton size="sm" label="Reveal in Finder (⌥⌘R)" icon={<FolderOpen size={14} strokeWidth={1.6} />} onClick={revealInFinder} />
            </span>
        </div>
    );
}
