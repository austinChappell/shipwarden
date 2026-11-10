import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ExternalLink, FileX, FolderOpen, Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { formatSize, type FileInfo } from '@shared/file-types';
import { fileUrl } from '@shared/file-url';
import { baseName } from '@shared/files';
import { clampZoom, fitZoom, stepZoom } from '../files/zoom';

interface FileProps {
    root: string;
    path: string;
    info: FileInfo;
    /** Increases when the file changes on disk. The viewer then loads the file again. */
    version: number;
    onError(message: string): void;
}

function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** The buttons that show the file in the Finder or open it in the default app. */
function FileActions({ root, path, onError, canOpen }: { root: string; path: string; onError(message: string): void; canOpen: boolean }) {
    const files = window.shipwarden.files;
    return (
        <>
            {canOpen && (
                <button
                    className="icon-button"
                    title="Open in the default app"
                    onClick={() => files.openInDefaultApp(root, path).catch(error => onError(errorText(error)))}
                >
                    <ExternalLink size={14} strokeWidth={1.8} />
                </button>
            )}
            <button className="icon-button" title="Show in Finder" onClick={() => files.reveal(root, path).catch(error => onError(errorText(error)))}>
                <FolderOpen size={14} strokeWidth={1.8} />
            </button>
        </>
    );
}

/** The bar at the top of a viewer. */
function ViewerBar({ children, details }: { children?: ReactNode; details: ReactNode }) {
    return (
        <div className="viewer-bar">
            <span className="viewer-details">{details}</span>
            <span className="viewer-actions">{children}</span>
        </div>
    );
}

/**
 * Shows an image. The image is an <img> element, also for SVG, so scripts in an SVG file cannot run.
 * "Fit" makes a large image small enough to show fully. A small image keeps its size.
 * ⌘ and the scroll wheel (or a pinch on the trackpad) change the zoom.
 */
export function ImageView({ root, path, info, version, onError }: FileProps) {
    const stageRef = useRef<HTMLDivElement>(null);
    const [mode, setMode] = useState<'fit' | number>('fit');
    const [natural, setNatural] = useState<{ width: number; height: number }>();
    const [box, setBox] = useState({ width: 0, height: 0 });
    const [failed, setFailed] = useState(false);

    // A new version of the file can load when the old version did not.
    // biome-ignore lint/correctness/useExhaustiveDependencies: A new version clears the old failure.
    useEffect(() => setFailed(false), [version]);

    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;
        const observer = new ResizeObserver(() => setBox({ width: stage.clientWidth - 32, height: stage.clientHeight - 32 }));
        observer.observe(stage);
        return () => observer.disconnect();
    }, []);

    const fit = natural ? fitZoom(natural.width, natural.height, box.width, box.height) : 1;
    const zoom = mode === 'fit' ? fit : mode;

    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;
        // React adds wheel listeners as passive listeners. A passive listener cannot stop the page zoom.
        const onWheel = (event: WheelEvent) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            setMode(current => clampZoom((current === 'fit' ? fit : current) * Math.exp(-event.deltaY * 0.01)));
        };
        stage.addEventListener('wheel', onWheel, { passive: false });
        return () => stage.removeEventListener('wheel', onWheel);
    }, [fit]);

    const sized = natural && natural.width > 0 && natural.height > 0;
    const style = sized
        ? { width: natural.width * zoom, height: natural.height * zoom, imageRendering: zoom >= 2 ? ('pixelated' as const) : undefined }
        : { maxWidth: '100%', maxHeight: '100%' };

    const details = (
        <>
            {sized && (
                <span>
                    {natural.width} × {natural.height}
                </span>
            )}
            <span>{formatSize(info.size)}</span>
        </>
    );

    return (
        <div className="viewer">
            <ViewerBar details={details}>
                <button className={`button compact${mode === 'fit' ? ' selected' : ''}`} title="Fit the image in the view" onClick={() => setMode('fit')}>
                    <Maximize size={13} strokeWidth={1.8} /> Fit
                </button>
                <button className={`button compact${mode === 1 ? ' selected' : ''}`} title="Show the image at its real size" onClick={() => setMode(1)}>
                    100%
                </button>
                <button className="icon-button" title="Zoom out" onClick={() => setMode(clampZoom(stepZoom(zoom, -1)))}>
                    <ZoomOut size={14} strokeWidth={1.8} />
                </button>
                <span className="viewer-zoom">{Math.round(zoom * 100)}%</span>
                <button className="icon-button" title="Zoom in" onClick={() => setMode(clampZoom(stepZoom(zoom, 1)))}>
                    <ZoomIn size={14} strokeWidth={1.8} />
                </button>
                <span className="viewer-separator" />
                <FileActions root={root} path={path} onError={onError} canOpen />
            </ViewerBar>
            <div className="viewer-stage image-stage" ref={stageRef}>
                {failed ? (
                    <div className="viewer-message">The image did not load. The file can be damaged, or Chromium cannot show this format.</div>
                ) : (
                    <img
                        className="image-view checkerboard"
                        src={fileUrl(root, path, version)}
                        alt={baseName(path)}
                        draggable={false}
                        style={style}
                        onLoad={event => {
                            setFailed(false);
                            setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
                        }}
                        onError={() => setFailed(true)}
                    />
                )}
            </div>
        </div>
    );
}

/**
 * Shows a PDF file in the built-in PDF viewer of Chromium. The frame gets the file from the `shipwarden-file:` protocol.
 * The frame has a different origin than the app, and the preload script does not run in frames.
 */
export function PdfView({ root, path, info, version, onError }: FileProps) {
    return (
        <div className="viewer">
            <ViewerBar details={<span>{formatSize(info.size)}</span>}>
                <FileActions root={root} path={path} onError={onError} canOpen />
            </ViewerBar>
            <iframe className="viewer-stage pdf-frame" src={fileUrl(root, path, version)} title={baseName(path)} />
        </div>
    );
}

/** Plays an audio or a video file with the controls of Chromium. */
export function MediaPlayerView({ root, path, info, version, onError }: FileProps) {
    const [failed, setFailed] = useState(false);
    const source = fileUrl(root, path, version);

    // biome-ignore lint/correctness/useExhaustiveDependencies: A new version clears the old failure.
    useEffect(() => setFailed(false), [version]);
    return (
        <div className="viewer">
            <ViewerBar details={<span>{formatSize(info.size)}</span>}>
                <FileActions root={root} path={path} onError={onError} canOpen />
            </ViewerBar>
            <div className="viewer-stage media-stage">
                {failed ? (
                    <div className="viewer-message">Chromium cannot play this file. Open it in the default app.</div>
                ) : info.kind === 'audio' ? (
                    <audio controls src={source} onError={() => setFailed(true)} />
                ) : (
                    <video controls src={source} onError={() => setFailed(true)} />
                )}
            </div>
        </div>
    );
}

interface UnsupportedProps {
    root: string;
    path: string;
    info: FileInfo;
    reason: 'binary' | 'large';
    onError(message: string): void;
}

/** Tells the user that ShipWarden cannot show the file. This panel replaces the editor for binary and very large files. */
export function UnsupportedFileView({ root, path, info, reason, onError }: UnsupportedProps) {
    return (
        <div className="viewer">
            <div className="viewer-stage unsupported-file">
                <FileX size={40} strokeWidth={1.4} />
                <div className="unsupported-name">{baseName(path)}</div>
                <div className="unsupported-text">
                    {reason === 'binary'
                        ? 'ShipWarden cannot show this file. It is a binary file.'
                        : 'ShipWarden cannot show this file. It is larger than 5 MB.'}
                </div>
                <div className="unsupported-size">{formatSize(info.size)}</div>
                <button className="button" onClick={() => window.shipwarden.files.reveal(root, path).catch(error => onError(errorText(error)))}>
                    Show in Finder
                </button>
            </div>
        </div>
    );
}
