import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, X } from 'lucide-react';
import { openLink } from '../links';
import { IconButton } from './ui';
import { useModal } from './use-modal';

/**
 * An image or a video of a Markdown text, for the larger view.
 * - `origin` is the small image or video in the text. The large view grows from it and goes back to it.
 * - `width` and `height` are the size of the media in pixels.
 */
export type ZoomedMedia = { origin: HTMLElement; width: number; height: number } & (
    | { kind: 'image'; src: string; alt: string }
    | { kind: 'video'; src: string; time: number }
);

/** The time of the open and the close animations, in milliseconds. */
const DURATION = 200;

/** The curve of the open animation. The media slows down at the end, but moves at a visible speed at the start. */
const OPEN_EASING = 'cubic-bezier(0.25, 0.8, 0.25, 1)';

/** The longest time, in milliseconds, that the open animation waits for the media to paint. */
const READY_TIMEOUT = 300;

/** The space between the media and the edges of the window, in pixels. Keep it equal to the padding of `.media-dialog`. */
const MARGIN = { top: 48, side: 32, bottom: 32 };

/**
 * Returns the size of the media in the window. The media keeps its aspect ratio, and does not get larger than its own size.
 * Exported for the tests.
 */
export function fitSize(width: number, height: number, room: { width: number; height: number }): { width: number; height: number } {
    if (width <= 0 || height <= 0) return { width: 0, height: 0 };
    const scale = Math.min(1, room.width / width, room.height / height);
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Returns the transform that moves and scales the box `to` onto the box `from`. The transform origin is the top left. */
function transformFrom(from: DOMRect, to: DOMRect): string {
    return `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
}

/** Resolves when the image is decoded, or when the video has its first frame. It never rejects. */
function mediaReady(element: HTMLImageElement | HTMLVideoElement): Promise<void> {
    if (element instanceof HTMLImageElement) return element.decode().catch(() => undefined);
    if (element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
    return new Promise(resolve => {
        const done = () => resolve();
        element.addEventListener('loadeddata', done, { once: true });
        element.addEventListener('error', done, { once: true });
    });
}

function reducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Shows an image or a video of a pull request (or other Markdown text) large, over the window.
 * - The media grows from its place in the text. When the dialog closes, the media goes back to that place.
 * - Escape, the Close button, or a click next to the media closes the dialog.
 * - A video starts at the time where the small player stopped.
 */
export function MediaDialog({ media, onClose }: { media: ZoomedMedia; onClose(): void }) {
    const dialog = useRef<HTMLDivElement>(null);
    const content = useRef<HTMLImageElement & HTMLVideoElement>(null);
    const closing = useRef(false);
    useModal(dialog);
    const label = media.kind === 'image' ? media.alt || 'Image' : 'Video';

    const [room, setRoom] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
    useEffect(() => {
        const onResize = () => setRoom({ width: window.innerWidth, height: window.innerHeight });
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);
    const size = fitSize(media.width, media.height, {
        width: room.width - 2 * MARGIN.side,
        height: room.height - MARGIN.top - MARGIN.bottom
    });

    // The large media waits, hidden, until it can paint: an image must decode, and a video must load its first frame.
    // Then the small media hides and the large media grows from its place. Without the wait, the motion ends before the media shows.
    // The effect runs before the paint, so the large view never shows at its end place first.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The animation runs one time, when the dialog opens.
    useLayoutEffect(() => {
        const { origin } = media;
        const element = content.current;
        if (!element || reducedMotion()) {
            origin.style.visibility = 'hidden';
            return () => {
                origin.style.visibility = '';
            };
        }
        let cancelled = false;
        element.style.opacity = '0';
        dialog.current?.animate([{ backgroundColor: 'transparent' }, {}], { duration: DURATION, easing: 'ease-out' });
        const start = () => {
            if (cancelled || closing.current) return;
            element.style.opacity = '';
            origin.style.visibility = 'hidden';
            element.animate([{ transform: transformFrom(origin.getBoundingClientRect(), element.getBoundingClientRect()) }, { transform: 'none' }], {
                duration: DURATION,
                easing: OPEN_EASING
            });
        };
        // A slow image or video does not stop the animation for more than a short time.
        const timeout = window.setTimeout(start, READY_TIMEOUT);
        mediaReady(element).then(() => {
            window.clearTimeout(timeout);
            requestAnimationFrame(start);
        });
        return () => {
            cancelled = true;
            window.clearTimeout(timeout);
            origin.style.visibility = '';
        };
    }, []);

    /** Moves the media back to its place in the text, then closes the dialog. */
    const close = () => {
        if (closing.current) return;
        closing.current = true;
        const element = content.current;
        const { origin } = media;
        const target = origin.isConnected ? origin.getBoundingClientRect() : undefined;
        // The small media can be out of the view, for example after a scroll. Then the media only fades.
        const visible = target && target.width > 0 && target.bottom > 0 && target.top < window.innerHeight;
        if (!element || reducedMotion()) {
            onClose();
            return;
        }
        for (const animation of element.getAnimations()) animation.cancel();
        // The close can come before the open animation starts. Then the large media is still hidden.
        element.style.opacity = '';
        dialog.current?.classList.add('closing');
        dialog.current?.animate([{}, { backgroundColor: 'transparent' }], { duration: DURATION, easing: 'ease-in', fill: 'forwards' });
        const animation = element.animate(
            visible ? [{ transform: 'none' }, { transform: transformFrom(target, element.getBoundingClientRect()) }] : [{ opacity: 1 }, { opacity: 0 }],
            { duration: DURATION, easing: 'cubic-bezier(0.3, 0, 0.8, 0.15)', fill: 'forwards' }
        );
        animation.onfinish = onClose;
    };

    const style = size.width > 0 ? { width: size.width, height: size.height } : undefined;

    return createPortal(
        <div
            ref={dialog}
            className="media-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={label}
            onMouseDown={event => event.target === event.currentTarget && close()}
            onKeyDown={event => {
                if (event.key === 'Escape') {
                    event.stopPropagation();
                    close();
                }
            }}
        >
            <div className="media-dialog-actions">
                <IconButton
                    icon={<ExternalLink size={15} strokeWidth={1.8} />}
                    label="Open in browser"
                    title="Open in browser"
                    onClick={event => openLink(media.src, event)}
                />
                <IconButton icon={<X size={15} strokeWidth={1.8} />} label="Close" title="Close (Escape)" autoFocus onClick={close} />
            </div>
            {media.kind === 'image' ? (
                <img ref={content} className="media-dialog-content" src={media.src} alt={media.alt} style={style} />
            ) : (
                <video
                    ref={content}
                    className="media-dialog-content"
                    src={`${media.src.split('#')[0]}#t=${media.time}`}
                    style={style}
                    controls
                    autoPlay
                    playsInline
                />
            )}
        </div>,
        document.body
    );
}
