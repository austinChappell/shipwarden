import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { MAX_TEXT_FILE_SIZE, type FileInfo } from '@shared/file-types';
import { parentPath } from '@shared/files';
import { useFolderVersion } from '../files/use-file-changes';
import { EditorView } from './EditorView';
import { MarkdownFileView } from './MarkdownFileView';
import { ImageView, MediaPlayerView, PdfView, UnsupportedFileView } from './MediaView';

type Props = ComponentProps<typeof MarkdownFileView>;

/**
 * Shows a file in the view for its kind: the editor for text, the editor and a preview for Markdown, a viewer for
 * images, PDF, audio and video, and a panel for binary files. The main process tells the kind (`files.info`).
 */
export function FileView(props: Props) {
    const { root, path, onError } = props;
    const [info, setInfo] = useState<FileInfo>();
    const [failure, setFailure] = useState<string>();
    const version = useFolderVersion(root, () => [parentPath(path)]);
    const loaded = useRef(false);

    // biome-ignore lint/correctness/useExhaustiveDependencies: A new folder version reads the file information again.
    useEffect(() => {
        let current = true;
        window.shipwarden.files.info(root, path).then(
            next => {
                if (!current) return;
                loaded.current = true;
                setFailure(undefined);
                // Keep the same object when nothing changed, so the view does not render again.
                setInfo(previous => (previous && previous.size === next.size && previous.kind === next.kind ? previous : next));
            },
            error => {
                // After the first load, a failure usually means that the file was deleted. Keep the last view.
                if (!current || loaded.current) return;
                setFailure((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
            }
        );
        return () => {
            current = false;
        };
    }, [root, path, version]);

    if (failure) {
        return (
            <div className="editor">
                <div className="editor-failure">{failure}</div>
            </div>
        );
    }
    if (!info) {
        return null;
    }
    const fileProps = { root, path, info, version, onError };
    switch (info.kind) {
        case 'image':
            return <ImageView {...fileProps} />;
        case 'pdf':
            return <PdfView {...fileProps} />;
        case 'audio':
        case 'video':
            return <MediaPlayerView {...fileProps} />;
        case 'binary':
            return <UnsupportedFileView {...fileProps} reason="binary" />;
        case 'markdown':
            return info.size > MAX_TEXT_FILE_SIZE ? <UnsupportedFileView {...fileProps} reason="large" /> : <MarkdownFileView {...props} />;
        default:
            return info.size > MAX_TEXT_FILE_SIZE ? <UnsupportedFileView {...fileProps} reason="large" /> : <EditorView {...props} />;
    }
}
