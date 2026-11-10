import { useEffect, useMemo, useRef, useState, type ComponentProps, type MouseEvent } from 'react';
import { Code, Columns2, Eye } from 'lucide-react';
import { fileUrl, resolveRelativeLink } from '@shared/file-url';
import { parentPath } from '@shared/files';
import { documents } from '../editor/documents';
import { useFolderVersion } from '../files/use-file-changes';
import { EditorView } from './EditorView';
import { HEADING_ID_PREFIX, renderMarkdownFile } from './Markdown';
import { radioGroupKeys } from './keyboard';

export type MarkdownMode = 'source' | 'split' | 'preview';

const MODE_KEY = 'shipwarden.markdownMode';
/** The time between a change in the editor and the new preview. */
const PREVIEW_DELAY_MS = 120;

function savedMode(): MarkdownMode {
    try {
        const value = localStorage.getItem(MODE_KEY);
        return value === 'source' || value === 'split' || value === 'preview' ? value : 'preview';
    } catch {
        return 'preview';
    }
}

type Props = ComponentProps<typeof EditorView> & {
    /** Opens a file of the same worktree in a tab. A relative link in the preview uses it. */
    onOpenFile(path: string): void;
};

/**
 * Shows a Markdown file as source (Monaco), as a rendered preview, or both side by side.
 * The preview reads the Monaco model, so it shows unsaved changes. The model loads the file again when it changes on
 * disk, so the preview also shows the changes of an agent. The last selected mode applies to the next Markdown file.
 */
export function MarkdownFileView(props: Props) {
    const { root, path, revealLine, revealNonce, onOpenFile } = props;
    const [mode, setModeState] = useState<MarkdownMode>(savedMode);

    const setMode = (next: MarkdownMode) => {
        setModeState(next);
        try {
            localStorage.setItem(MODE_KEY, next);
        } catch {
            // The mode applies to this view only.
        }
    };

    // A search result or a definition must show its line, so the source must show.
    useEffect(() => {
        if (revealLine) {
            setModeState(current => (current === 'preview' ? 'split' : current));
        }
    }, [revealLine, revealNonce]);

    const modes: [MarkdownMode, string, typeof Code][] = [
        ['source', 'Source', Code],
        ['split', 'Side by side', Columns2],
        ['preview', 'Preview', Eye]
    ];

    return (
        <div className="viewer">
            <div className="viewer-bar">
                <span className="viewer-details" />
                <span className="viewer-actions">
                    <div className="segmented compact markdown-modes" role="radiogroup" aria-label="Markdown view" onKeyDown={radioGroupKeys}>
                        {modes.map(([value, label, Icon]) => (
                            <button
                                key={value}
                                role="radio"
                                aria-checked={mode === value}
                                className={mode === value ? 'selected' : ''}
                                title={label}
                                onClick={() => setMode(value)}
                            >
                                <Icon size={13} strokeWidth={1.8} /> {label}
                            </button>
                        ))}
                    </div>
                </span>
            </div>
            <div className={`markdown-file-body ${mode}`}>
                {mode !== 'preview' && (
                    <div className="markdown-file-source">
                        <EditorView {...props} />
                    </div>
                )}
                {mode !== 'source' && <MarkdownPreview root={root} path={path} onOpenFile={onOpenFile} onError={props.onError} />}
            </div>
        </div>
    );
}

interface PreviewProps {
    root: string;
    path: string;
    onOpenFile(path: string): void;
    onError(message: string): void;
}

/** The rendered Markdown of a file. Relative image links resolve against the folder of the file. */
function MarkdownPreview({ root, path, onOpenFile, onError }: PreviewProps) {
    const [text, setText] = useState<string>();
    const containerRef = useRef<HTMLDivElement>(null);
    const imageFolders = useRef(new Set<string>());
    // Images load again when a file in one of their folders changes.
    const imageVersion = useFolderVersion(root, () => imageFolders.current);

    useEffect(() => {
        let disposed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let subscription: { dispose(): void } | undefined;
        documents.open(root, path).then(
            model => {
                if (disposed) return;
                setText(model.getValue());
                subscription = model.onDidChangeContent(() => {
                    clearTimeout(timer);
                    timer = setTimeout(() => setText(model.getValue()), PREVIEW_DELAY_MS);
                });
            },
            error => onError(error instanceof Error ? error.message : String(error))
        );
        return () => {
            disposed = true;
            clearTimeout(timer);
            subscription?.dispose();
        };
    }, [root, path]);

    const html = useMemo(() => {
        if (text === undefined) return '';
        const folders = new Set<string>();
        const result = renderMarkdownFile(text, source => {
            if (/^(https:|data:image\/)/i.test(source)) return source;
            const target = resolveRelativeLink(path, source);
            // Other schemes (for example "http:" or "file:") do not load. A path outside the worktree does not load.
            if (!target) return undefined;
            folders.add(parentPath(target));
            return fileUrl(root, target, imageVersion);
        });
        imageFolders.current = folders;
        return result;
    }, [text, root, path, imageVersion]);

    const onClick = (event: MouseEvent<HTMLDivElement>) => {
        const link = (event.target as HTMLElement).closest('a');
        if (!link) return;
        event.preventDefault();
        const href = link.getAttribute('href') ?? '';
        if (/^https?:\/\//i.test(href)) {
            window.shipwarden.github.openInBrowser(href);
            return;
        }
        if (href.startsWith('#')) {
            let id = href.slice(1);
            try {
                id = decodeURIComponent(id);
            } catch {
                // Use the name as it is.
            }
            const heading = containerRef.current?.querySelector(`[id="${CSS.escape(HEADING_ID_PREFIX + id.toLowerCase())}"]`);
            heading?.scrollIntoView({ block: 'start' });
            return;
        }
        const target = resolveRelativeLink(path, href);
        if (target) {
            // A link can point to a folder or to a file that does not exist. Only a file opens.
            window.shipwarden.files.info(root, target).then(
                () => onOpenFile(target),
                () => onError(`The link "${href}" does not point to a file in this worktree.`)
            );
        }
    };

    return (
        <div className="markdown-file-preview" ref={containerRef}>
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdownFile cleans the HTML with DOMPurify. */}
            <div className="markdown markdown-document" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
        </div>
    );
}
